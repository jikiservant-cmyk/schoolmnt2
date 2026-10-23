-- =============================================================================
-- 11_round13_money_integrity.sql: Round 13 Deep Money, Webhook & Wallet Hardening
-- =============================================================================
-- Idempotent migration. Run AFTER 05, 06, 07, 08, 09, and 10.
-- Closes:
--  1. Placeholder / short reference poisoning in school.apply_payment() where
--     shared non-unique tags ("N/A", "0", "MTN", "NONE", etc.) caused unrelated
--     schools' real Mobile Money payments to return {"outcome":"duplicate"}.
--  2. Fractional sub-shilling tampering (e.g. 0.001 UGX burning a 50,000 UGX
--     pending payment_intent and desynchronizing numeric vs numeric(14,2) ledgers).
--  3. Cross-instance TOCTOU race condition on durable top-up quota checks via
--     atomic advisory-locked school.create_payment_intent().
--  4. Wallet kernel invariants on public.wallets: blocks cross-tenant hybrid rows
--     (tenant_id <> school_id), negative or NaN wallet balances, and stamps
--     settings.wallet_migrated = true permanently upon wallet migration/credit.
--  5. Atomic server-only SMS wallet debit function school.debit_sms_wallet().
--  6. Reconciles missing delivery columns on school.notifications (provider_ref,
--     sent_at, provider_response) while preserving client write lockdown (06).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Notification delivery schema reconciliation (strict PostgREST safe)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('school.notifications') IS NOT NULL THEN
    ALTER TABLE school.notifications ADD COLUMN IF NOT EXISTS provider_ref text;
    ALTER TABLE school.notifications ADD COLUMN IF NOT EXISTS sent_at timestamptz;
    ALTER TABLE school.notifications ADD COLUMN IF NOT EXISTS provider_response jsonb;

    CREATE INDEX IF NOT EXISTS notifications_provider_ref_idx
      ON school.notifications (provider_ref)
      WHERE provider_ref IS NOT NULL;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON school.notifications FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON school.notifications FROM authenticated';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Wallet kernel constraints (no cross-tenant hybrid rows, no <0 / NaN)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.wallets') IS NOT NULL THEN
    -- Normalize any pre-existing invalid test/legacy rows safely before adding constraints
    UPDATE public.wallets
       SET school_id = tenant_id
     WHERE tenant_id IS NOT NULL AND school_id IS NOT NULL AND tenant_id <> school_id;

    UPDATE public.wallets
       SET balance = 0
     WHERE balance IS NOT NULL AND (balance = 'NaN'::numeric OR balance < 0);

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'wallets_same_tenant_chk'
         AND conrelid = 'public.wallets'::regclass
    ) THEN
      ALTER TABLE public.wallets
        ADD CONSTRAINT wallets_same_tenant_chk
        CHECK (tenant_id IS NULL OR school_id IS NULL OR tenant_id = school_id);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'wallets_non_negative_balance_chk'
         AND conrelid = 'public.wallets'::regclass
    ) THEN
      ALTER TABLE public.wallets
        ADD CONSTRAINT wallets_non_negative_balance_chk
        CHECK (balance IS NULL OR (balance <> 'NaN'::numeric AND balance >= 0));
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Sanitize payment reference tokens (rejects shared placeholders / noise)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION school.clean_payment_refs(p_refs text[])
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_raw text;
  v_tok text;
  v_low text;
  v_out text[] := ARRAY[]::text[];
BEGIN
  IF p_refs IS NULL THEN
    RETURN v_out;
  END IF;

  FOREACH v_raw IN ARRAY p_refs LOOP
    IF v_raw IS NULL THEN
      CONTINUE;
    END IF;
    v_tok := btrim(v_raw);
    IF v_tok = '' OR char_length(v_tok) > 200 THEN
      CONTINUE;
    END IF;
    v_low := lower(v_tok);
    IF v_low IN (
      '0', 'null', 'undefined', 'none', 'n/a', 'na', 'nil', 'unknown',
      'pending', 'failed', 'failure', 'success', 'succeeded', 'completed', 'paid',
      'true', 'false', 'test', 'general', 'topup', 'top-up', 'top_up',
      'school', 'mtn', 'airtel', 'ugx', 'sms', 'credit', 'wallet', 'payment'
    ) THEN
      CONTINUE;
    END IF;
    -- Short non-unique tokens (<4 chars) are never valid transaction references
    IF char_length(v_tok) < 4 THEN
      CONTINUE;
    END IF;
    IF NOT (v_tok = ANY (v_out)) THEN
      v_out := v_out || v_tok;
    END IF;
  END LOOP;

  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Atomic advisory-locked payment intent creation (closes multi-instance race)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION school.create_payment_intent(
  p_school_id   uuid,
  p_reference   text,
  p_amount      numeric,
  p_currency    text DEFAULT 'UGX',
  p_phone       text DEFAULT NULL,
  p_created_by  uuid DEFAULT NULL,
  p_max_per_10m integer DEFAULT 6)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, school, public
AS $$
DECLARE
  v_cur    text := upper(coalesce(nullif(btrim(p_currency), ''), 'UGX'));
  v_phone  text := btrim(coalesce(p_phone, ''));
  v_ref    text := btrim(coalesce(p_reference, ''));
  v_recent integer;
  v_id     uuid;
BEGIN
  IF p_school_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_school');
  END IF;
  IF v_ref = '' OR char_length(v_ref) < 8 OR char_length(v_ref) > 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid_reference');
  END IF;
  IF p_amount IS NULL OR p_amount = 'NaN'::numeric OR p_amount < 1 OR p_amount > 10000000 OR p_amount <> trunc(p_amount) THEN
    RETURN jsonb_build_object('outcome', 'invalid_amount');
  END IF;
  IF v_cur <> 'UGX' THEN
    RETURN jsonb_build_object('outcome', 'currency_mismatch');
  END IF;
  IF v_phone !~ '^[1-9][0-9]{8,14}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid_phone');
  END IF;
  IF p_max_per_10m IS NULL OR p_max_per_10m < 1 THEN
    p_max_per_10m := 6;
  END IF;

  -- Serialize all top-up intent creations per school across ALL app instances
  PERFORM pg_advisory_xact_lock(hashtext('smartskoolz.topup_intent:' || p_school_id::text));

  SELECT count(*)::integer INTO v_recent
    FROM school.payment_intents
   WHERE school_id = p_school_id
     AND created_at >= now() - interval '10 minutes';

  IF v_recent >= p_max_per_10m THEN
    RETURN jsonb_build_object('outcome', 'rate_limited', 'recent', v_recent);
  END IF;

  INSERT INTO school.payment_intents (school_id, reference, amount, currency, phone, created_by)
  VALUES (p_school_id, v_ref, p_amount, v_cur, v_phone, p_created_by)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('outcome', 'created', 'id', v_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Hardened school.apply_payment() (zero money black holes, integer UGX, exact ledger)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION school.apply_payment(
  p_refs           text[],           -- every reference found in the webhook
  p_provider_ref   text,             -- the provider's own transaction id
  p_amount         numeric,          -- amount the provider says was paid
  p_currency       text,
  p_claimed_school uuid,             -- school named in the webhook (may be NULL)
  p_require_intent boolean DEFAULT true,
  p_detail         jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, school, public
AS $$
DECLARE
  v_intent       school.payment_intents%ROWTYPE;
  v_school       uuid;
  v_credit       numeric;
  v_key          text;
  v_wallet       uuid;
  v_bal          numeric;
  v_legacy       numeric;
  v_cur          text := upper(coalesce(nullif(btrim(p_currency), ''), 'UGX'));
  v_prov_clean   text;
  v_refs         text[];
BEGIN
  -- Clean provider_ref and refs so placeholder strings ("N/A", "0", "MTN", etc.)
  -- never poison deduplication across unrelated payments or tenants.
  SELECT (school.clean_payment_refs(ARRAY[p_provider_ref]))[1] INTO v_prov_clean;
  v_refs := school.clean_payment_refs(coalesce(p_refs, ARRAY[]::text[]));
  IF v_prov_clean IS NOT NULL AND NOT (v_prov_clean = ANY (v_refs)) THEN
    v_refs := v_refs || v_prov_clean;
  END IF;

  -- Reject NaN, non-positive, > 50,000,000 UGX, or sub-shilling fractional amounts
  IF p_amount IS NULL
     OR p_amount = 'NaN'::numeric
     OR p_amount < 1
     OR p_amount > 50000000
     OR p_amount <> trunc(p_amount) THEN
    PERFORM school.log_payment_event('invalid_amount', v_refs[1], v_prov_clean, NULL, p_claimed_school, NULL, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'invalid_amount');
  END IF;

  IF v_cur <> 'UGX' THEN
    PERFORM school.log_payment_event('currency_mismatch', v_refs[1], v_prov_clean, NULL, p_claimed_school, p_amount, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'currency_mismatch', 'currency', v_cur);
  END IF;

  -- Serialize payment application globally for race-free idempotency and wallet updates
  PERFORM pg_advisory_xact_lock(hashtext('smartskoolz.apply_payment'));

  IF v_prov_clean IS NOT NULL AND EXISTS (
       SELECT 1 FROM school.payment_events WHERE provider_ref = v_prov_clean AND outcome = 'credited') THEN
    PERFORM school.log_payment_event('duplicate', v_refs[1], v_prov_clean, NULL, p_claimed_school, p_amount, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'duplicate');
  END IF;

  IF cardinality(v_refs) > 0 AND EXISTS (
       SELECT 1 FROM school.payment_events
        WHERE outcome = 'credited' AND (detail -> 'refs') ?| v_refs) THEN
    PERFORM school.log_payment_event('duplicate', v_refs[1], v_prov_clean, NULL, p_claimed_school, p_amount, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'duplicate');
  END IF;

  -- 1. Match the payment to a top-up started by the app
  SELECT * INTO v_intent FROM school.payment_intents
   WHERE reference = ANY (v_refs)
      OR (provider_ref IS NOT NULL AND (provider_ref = ANY (v_refs) OR provider_ref = v_prov_clean))
   ORDER BY created_at LIMIT 1 FOR UPDATE;

  -- Fallback: school's oldest pending top-up of exact amount within 48h
  IF v_intent.id IS NULL AND p_claimed_school IS NOT NULL THEN
    SELECT * INTO v_intent FROM school.payment_intents
     WHERE school_id = p_claimed_school AND status = 'pending' AND amount = p_amount
       AND created_at > now() - interval '48 hours'
     ORDER BY created_at LIMIT 1 FOR UPDATE;
  END IF;

  IF v_intent.id IS NOT NULL THEN
    IF v_intent.status = 'credited' THEN
      PERFORM school.log_payment_event('duplicate', v_intent.reference, v_prov_clean, v_intent.id, v_intent.school_id, p_amount, NULL, v_cur, p_detail);
      RETURN jsonb_build_object('outcome', 'duplicate', 'school_id', v_intent.school_id);
    END IF;
    IF p_claimed_school IS NOT NULL AND p_claimed_school <> v_intent.school_id THEN
      PERFORM school.log_payment_event('school_mismatch', v_intent.reference, v_prov_clean, v_intent.id, p_claimed_school, p_amount, NULL, v_cur, p_detail);
      RETURN jsonb_build_object('outcome', 'school_mismatch');
    END IF;
    v_school := v_intent.school_id;
    v_credit := least(p_amount, v_intent.amount);
    v_key    := v_intent.reference;
  ELSIF p_require_intent THEN
    PERFORM school.log_payment_event('unmatched', v_refs[1], v_prov_clean, NULL, p_claimed_school, p_amount, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'unmatched');
  ELSE
    IF p_claimed_school IS NULL THEN
      PERFORM school.log_payment_event('no_school', v_refs[1], v_prov_clean, NULL, NULL, p_amount, NULL, v_cur, p_detail);
      RETURN jsonb_build_object('outcome', 'no_school');
    END IF;
    v_school := p_claimed_school;
    v_credit := p_amount;
    v_key    := coalesce(v_prov_clean, v_refs[1]);
  END IF;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'apply_payment: no reference to record the payment under';
  END IF;

  -- 2. Double-check ledger idempotency on public.transactions
  IF EXISTS (SELECT 1 FROM public.transactions WHERE reference = v_key) THEN
    IF v_intent.id IS NOT NULL THEN
      UPDATE school.payment_intents SET status = 'credited', credited_at = coalesce(credited_at, now())
       WHERE id = v_intent.id;
    END IF;
    PERFORM school.log_payment_event('duplicate', v_key, v_prov_clean, v_intent.id, v_school, p_amount, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'duplicate', 'school_id', v_school);
  END IF;

  -- 3. Deterministic single-tenant wallet lookup matching lib/payments/wallet.ts
  SELECT id INTO v_wallet FROM public.wallets
   WHERE (tenant_id = v_school AND (school_id IS NULL OR school_id = v_school))
      OR (school_id = v_school AND tenant_id IS NULL)
   ORDER BY (tenant_id = v_school) DESC NULLS LAST, balance DESC NULLS LAST, id
   LIMIT 1 FOR UPDATE;

  IF v_wallet IS NULL THEN
    v_legacy := 0;
    IF NOT EXISTS (SELECT 1 FROM school.payment_events WHERE school_id = v_school AND outcome = 'credited') THEN
      SELECT CASE
               WHEN coalesce((settings ->> 'wallet_migrated') = 'true', false) THEN 0
               WHEN (settings ->> 'balance') ~ '^[0-9]+(\.[0-9]+)?$' THEN greatest(0, (settings ->> 'balance')::numeric)
               ELSE 0
             END
        INTO v_legacy
        FROM school.schools
       WHERE id = v_school;
    END IF;
    INSERT INTO public.wallets (id, tenant_id, school_id, balance, currency)
    VALUES (gen_random_uuid(), v_school, v_school, coalesce(v_legacy, 0), 'UGX')
    RETURNING id INTO v_wallet;
  END IF;

  UPDATE public.wallets SET balance = coalesce(balance, 0) + v_credit
   WHERE id = v_wallet RETURNING balance INTO v_bal;

  INSERT INTO public.transactions (wallet_id, amount, type, reference, status, description)
  VALUES (v_wallet, v_credit, 'credit', v_key, 'completed',
          'NaJiki Mobile Money Top-up (+' || v_credit::text || ' UGX)');

  -- Keep legacy mirror synchronized AND stamp wallet_migrated = true permanently
  UPDATE school.schools
     SET settings = coalesce(settings, '{}'::jsonb)
                    || jsonb_build_object('balance', v_bal, 'wallet_migrated', true)
   WHERE id = v_school;

  IF v_intent.id IS NOT NULL THEN
    UPDATE school.payment_intents
       SET status = 'credited', credited_amount = v_credit, credited_at = now(),
           provider_ref = coalesce(provider_ref, v_prov_clean)
     WHERE id = v_intent.id;
  END IF;

  IF NOT (v_key = ANY (v_refs)) THEN
    v_refs := array_prepend(v_key, v_refs);
  END IF;

  PERFORM school.log_payment_event('credited', v_key, v_prov_clean, v_intent.id, v_school, p_amount, v_credit, v_cur,
    p_detail || jsonb_build_object('overpaid', p_amount > v_credit, 'refs', to_jsonb(v_refs)));

  RETURN jsonb_build_object('outcome', 'credited', 'school_id', v_school, 'amount', v_credit,
                            'reported_amount', p_amount, 'balance', v_bal, 'reference', v_key);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Atomic server-only SMS wallet debit function (prevents negative overdrafts)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION school.debit_sms_wallet(
  p_school_id   uuid,
  p_amount      numeric,
  p_reference   text,
  p_description text DEFAULT 'SMS Notification Charge')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, school, public
AS $$
DECLARE
  v_wallet uuid;
  v_curbal numeric;
  v_newbal numeric;
  v_ref    text := btrim(coalesce(p_reference, ''));
BEGIN
  IF p_school_id IS NULL OR v_ref = '' THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF p_amount IS NULL OR p_amount = 'NaN'::numeric OR p_amount <= 0 OR p_amount <> trunc(p_amount) THEN
    RETURN jsonb_build_object('outcome', 'invalid_amount');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('smartskoolz.apply_payment'));

  IF EXISTS (SELECT 1 FROM public.transactions WHERE reference = v_ref) THEN
    RETURN jsonb_build_object('outcome', 'duplicate');
  END IF;

  SELECT id, coalesce(balance, 0) INTO v_wallet, v_curbal
    FROM public.wallets
   WHERE (tenant_id = p_school_id AND (school_id IS NULL OR school_id = p_school_id))
      OR (school_id = p_school_id AND tenant_id IS NULL)
   ORDER BY (tenant_id = p_school_id) DESC NULLS LAST, balance DESC NULLS LAST, id
   LIMIT 1 FOR UPDATE;

  IF v_wallet IS NULL OR v_curbal < p_amount THEN
    RETURN jsonb_build_object('outcome', 'insufficient_funds', 'balance', coalesce(v_curbal, 0));
  END IF;

  UPDATE public.wallets SET balance = v_curbal - p_amount
   WHERE id = v_wallet RETURNING balance INTO v_newbal;

  INSERT INTO public.transactions (wallet_id, amount, type, reference, status, description)
  VALUES (v_wallet, -p_amount, 'debit', v_ref, 'completed', coalesce(p_description, 'SMS Notification Charge'));

  UPDATE school.schools
     SET settings = coalesce(settings, '{}'::jsonb)
                    || jsonb_build_object('balance', v_newbal, 'wallet_migrated', true)
   WHERE id = p_school_id;

  RETURN jsonb_build_object('outcome', 'debited', 'balance', v_newbal, 'amount', p_amount);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Strict privilege lockdown (service_role only on money functions & tables)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION school.clean_payment_refs(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION school.create_payment_intent(uuid, text, numeric, text, text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION school.apply_payment(text[], text, numeric, text, uuid, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION school.debit_sms_wallet(uuid, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION school.log_payment_event(text, text, text, uuid, uuid, numeric, numeric, text, jsonb) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION school.clean_payment_refs(text[]) FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION school.create_payment_intent(uuid, text, numeric, text, text, uuid, integer) FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION school.apply_payment(text[], text, numeric, text, uuid, boolean, jsonb) FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION school.debit_sms_wallet(uuid, numeric, text, text) FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION school.log_payment_event(text, text, text, uuid, uuid, numeric, numeric, text, jsonb) FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON school.payment_intents, school.payment_events FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE school.payment_events_id_seq FROM anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION school.clean_payment_refs(text[]) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION school.create_payment_intent(uuid, text, numeric, text, text, uuid, integer) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION school.apply_payment(text[], text, numeric, text, uuid, boolean, jsonb) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION school.debit_sms_wallet(uuid, numeric, text, text) TO service_role';
    EXECUTE 'GRANT ALL ON school.payment_intents, school.payment_events TO service_role';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE school.payment_events_id_seq TO service_role';
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE '11: Round 13 money, webhook, wallet, quota, and notification hardening applied'; END $$;
