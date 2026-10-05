-- =============================================================================
-- 05_sms_payment_integrity.sql
--
-- SMS wallet / payment integrity. Safe to re-run.
--
--  1. school.payment_intents: every top-up the app starts (school, amount,
--     reference). A webhook can only credit a payment the school really
--     started, and never more than the amount requested.
--  2. school.payment_events: an audit row for EVERY payment webhook
--     (credited, duplicate, unmatched, wrong currency...), for reconciliation.
--  3. school.apply_payment(): credits a payment in ONE transaction
--     (wallet balance + ledger row + settings mirror + intent status), so a
--     payment is credited exactly once, concurrent payments can't overwrite
--     each other, and a DB error rolls everything back so the provider retries.
--  4. A unique index on public.transactions(reference) when the data allows.
--
-- Run AFTER 04. Only the server (service_role) can call apply_payment().
-- =============================================================================

CREATE TABLE IF NOT EXISTS school.payment_intents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES school.schools(id) ON DELETE CASCADE,
  reference       text NOT NULL UNIQUE,
  amount          numeric(14,2) NOT NULL CHECK (amount > 0 AND amount <= 50000000),
  currency        text NOT NULL DEFAULT 'UGX',
  phone           text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'credited', 'failed', 'expired')),
  provider_ref    text,
  credited_amount numeric(14,2),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  credited_at     timestamptz
);
CREATE INDEX IF NOT EXISTS payment_intents_school_status_idx
  ON school.payment_intents (school_id, status, created_at);

CREATE TABLE IF NOT EXISTS school.payment_events (
  id              bigserial PRIMARY KEY,
  received_at     timestamptz NOT NULL DEFAULT now(),
  outcome         text NOT NULL,
  idempotency_key text,
  provider_ref    text,
  intent_id       uuid,
  school_id       uuid,
  amount          numeric(14,2),
  credited_amount numeric(14,2),
  currency        text,
  detail          jsonb
);
CREATE INDEX IF NOT EXISTS payment_events_provider_ref_idx ON school.payment_events (provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_events_outcome_idx ON school.payment_events (outcome, received_at);

-- Audit helper (internal).
CREATE OR REPLACE FUNCTION school.log_payment_event(
  p_outcome text, p_key text, p_provider_ref text, p_intent uuid, p_school uuid,
  p_amount numeric, p_credited numeric, p_currency text, p_detail jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, school, public AS $$
  INSERT INTO school.payment_events (outcome, idempotency_key, provider_ref, intent_id, school_id,
                                     amount, credited_amount, currency, detail)
  VALUES (p_outcome, p_key, p_provider_ref, p_intent, p_school, p_amount, p_credited, p_currency, p_detail);
$$;

-- Credit one payment. Returns jsonb {outcome, school_id, amount, balance, ...}.
-- outcome: credited | duplicate | unmatched | school_mismatch | currency_mismatch
--          | invalid_amount | no_school
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
  v_intent  school.payment_intents%ROWTYPE;
  v_school  uuid;
  v_credit  numeric;
  v_key     text;
  v_wallet  uuid;
  v_bal     numeric;
  v_legacy  numeric;
  v_cur     text := upper(coalesce(nullif(trim(p_currency), ''), 'UGX'));
  v_refs    text[] := coalesce(p_refs, ARRAY[]::text[]);
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 50000000 THEN
    PERFORM school.log_payment_event('invalid_amount', NULL, p_provider_ref, NULL, p_claimed_school, NULL, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'invalid_amount');
  END IF;
  IF v_cur <> 'UGX' THEN
    PERFORM school.log_payment_event('currency_mismatch', NULL, p_provider_ref, NULL, p_claimed_school, p_amount, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'currency_mismatch', 'currency', v_cur);
  END IF;

  -- Payments are low volume: process them strictly one at a time. This makes
  -- duplicate detection and balance updates race-free.
  PERFORM pg_advisory_xact_lock(hashtext('smartskoolz.apply_payment'));

  IF p_provider_ref IS NOT NULL AND EXISTS (
       SELECT 1 FROM school.payment_events WHERE provider_ref = p_provider_ref AND outcome = 'credited') THEN
    PERFORM school.log_payment_event('duplicate', NULL, p_provider_ref, NULL, p_claimed_school, p_amount, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'duplicate');
  END IF;

  -- 1. Match the payment to a top-up the app started: by reference first...
  SELECT * INTO v_intent FROM school.payment_intents
   WHERE reference = ANY (v_refs)
   ORDER BY created_at LIMIT 1 FOR UPDATE;
  -- ...or, if the provider didn't echo our reference, the school's oldest
  -- pending top-up of exactly this amount from the last 48 hours.
  IF v_intent.id IS NULL AND p_claimed_school IS NOT NULL THEN
    SELECT * INTO v_intent FROM school.payment_intents
     WHERE school_id = p_claimed_school AND status = 'pending' AND amount = p_amount
       AND created_at > now() - interval '48 hours'
     ORDER BY created_at LIMIT 1 FOR UPDATE;
  END IF;

  IF v_intent.id IS NOT NULL THEN
    IF v_intent.status = 'credited' THEN
      PERFORM school.log_payment_event('duplicate', v_intent.reference, p_provider_ref, v_intent.id, v_intent.school_id, p_amount, NULL, v_cur, p_detail);
      RETURN jsonb_build_object('outcome', 'duplicate', 'school_id', v_intent.school_id);
    END IF;
    IF p_claimed_school IS NOT NULL AND p_claimed_school <> v_intent.school_id THEN
      PERFORM school.log_payment_event('school_mismatch', v_intent.reference, p_provider_ref, v_intent.id, p_claimed_school, p_amount, NULL, v_cur, p_detail);
      RETURN jsonb_build_object('outcome', 'school_mismatch');
    END IF;
    v_school := v_intent.school_id;
    v_credit := least(p_amount, v_intent.amount);   -- never more than requested
    v_key    := v_intent.reference;
  ELSIF p_require_intent THEN
    PERFORM school.log_payment_event('unmatched', v_refs[1], p_provider_ref, NULL, p_claimed_school, p_amount, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'unmatched');
  ELSE
    -- Transition mode (NAJIKI_REQUIRE_PAYMENT_INTENT=false): trust the webhook.
    IF p_claimed_school IS NULL THEN
      PERFORM school.log_payment_event('no_school', v_refs[1], p_provider_ref, NULL, NULL, p_amount, NULL, v_cur, p_detail);
      RETURN jsonb_build_object('outcome', 'no_school');
    END IF;
    v_school := p_claimed_school;
    v_credit := p_amount;
    v_key    := coalesce(p_provider_ref, v_refs[1]);
  END IF;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'apply_payment: no reference to record the payment under';
  END IF;

  -- 2. Ledger: one credit per reference, ever (also covers credits made by the
  --    old code path before this migration).
  IF EXISTS (SELECT 1 FROM public.transactions WHERE reference = v_key) THEN
    IF v_intent.id IS NOT NULL THEN
      UPDATE school.payment_intents SET status = 'credited', credited_at = coalesce(credited_at, now())
       WHERE id = v_intent.id;
    END IF;
    PERFORM school.log_payment_event('duplicate', v_key, p_provider_ref, v_intent.id, v_school, p_amount, NULL, v_cur, p_detail);
    RETURN jsonb_build_object('outcome', 'duplicate', 'school_id', v_school);
  END IF;

  -- 3. The school's wallet: same choice as the app (lib/payments/wallet.ts):
  --    tenant_id match first, then the highest balance, then id.
  SELECT id INTO v_wallet FROM public.wallets
   WHERE tenant_id = v_school OR school_id = v_school
   ORDER BY (tenant_id = v_school) DESC NULLS LAST, balance DESC NULLS LAST, id
   LIMIT 1 FOR UPDATE;
  IF v_wallet IS NULL THEN
    -- First top-up: carry over any legacy balance kept in schools.settings.
    SELECT CASE WHEN (settings->>'balance') ~ '^[0-9]+(\.[0-9]+)?$'
                THEN (settings->>'balance')::numeric ELSE 0 END
      INTO v_legacy FROM school.schools WHERE id = v_school;
    INSERT INTO public.wallets (id, tenant_id, school_id, balance, currency)
    VALUES (gen_random_uuid(), v_school, v_school, coalesce(v_legacy, 0), 'UGX')
    RETURNING id INTO v_wallet;
  END IF;

  UPDATE public.wallets SET balance = coalesce(balance, 0) + v_credit
   WHERE id = v_wallet RETURNING balance INTO v_bal;

  INSERT INTO public.transactions (wallet_id, amount, type, reference, status, description)
  VALUES (v_wallet, v_credit, 'credit', v_key, 'completed',
          'NaJiki Mobile Money Top-up (+' || v_credit::text || ' UGX)');

  -- Keep the legacy mirror equal to the wallet (not incremented separately).
  UPDATE school.schools
     SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{balance}', to_jsonb(v_bal))
   WHERE id = v_school;

  IF v_intent.id IS NOT NULL THEN
    UPDATE school.payment_intents
       SET status = 'credited', credited_amount = v_credit, credited_at = now(),
           provider_ref = coalesce(p_provider_ref, provider_ref)
     WHERE id = v_intent.id;
  END IF;

  PERFORM school.log_payment_event('credited', v_key, p_provider_ref, v_intent.id, v_school, p_amount, v_credit, v_cur,
    p_detail || jsonb_build_object('overpaid', p_amount > v_credit));
  RETURN jsonb_build_object('outcome', 'credited', 'school_id', v_school, 'amount', v_credit,
                            'reported_amount', p_amount, 'balance', v_bal, 'reference', v_key);
END;
$$;

-- Permissions: only the server (service_role) may credit or log payments.
REVOKE ALL ON FUNCTION school.apply_payment(text[], text, numeric, text, uuid, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION school.log_payment_event(text, text, text, uuid, uuid, numeric, numeric, text, jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION school.apply_payment(text[], text, numeric, text, uuid, boolean, jsonb) FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION school.log_payment_event(text, text, text, uuid, uuid, numeric, numeric, text, jsonb) FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON school.payment_intents, school.payment_events FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON SEQUENCE school.payment_events_id_seq FROM anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION school.apply_payment(text[], text, numeric, text, uuid, boolean, jsonb) TO service_role';
    EXECUTE 'GRANT ALL ON school.payment_intents, school.payment_events TO service_role';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE school.payment_events_id_seq TO service_role';
  END IF;
END $$;

ALTER TABLE school.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE school.payment_events  ENABLE ROW LEVEL SECURITY;

-- School admins may READ their own school's top-ups (e.g. a history screen).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'school' AND p.proname = 'auth_school_id' AND p.pronargs = 0)
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    DROP POLICY IF EXISTS payment_intents_read_own ON school.payment_intents;
    CREATE POLICY payment_intents_read_own ON school.payment_intents
      FOR SELECT TO authenticated USING (school_id = school.auth_school_id());
    GRANT SELECT ON school.payment_intents TO authenticated;
  ELSE
    RAISE NOTICE 'school.auth_school_id() not found: payment_intents stays server-only (run 04 first)';
  END IF;
END $$;

-- One ledger row per reference (database-level guard against double credit).
DO $$ BEGIN
  IF to_regclass('public.transactions') IS NULL THEN
    RAISE NOTICE 'public.transactions not found: skipped unique reference index';
  ELSIF EXISTS (SELECT reference FROM public.transactions WHERE reference IS NOT NULL
                GROUP BY reference HAVING count(*) > 1) THEN
    RAISE WARNING 'public.transactions already has DUPLICATE references (past double credits?). '
                  'Review: SELECT reference, count(*), sum(amount) FROM public.transactions GROUP BY 1 HAVING count(*) > 1; '
                  'then re-run this migration to add the unique index.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS transactions_reference_uniq
      ON public.transactions (reference) WHERE reference IS NOT NULL;
    RAISE NOTICE 'unique index on public.transactions(reference) in place';
  END IF;
END $$;

-- Wallets: report schools with more than one wallet (the old top-up code could
-- create duplicates on double-click). Nothing is changed automatically.
DO $$
DECLARE n int;
BEGIN
  IF to_regclass('public.wallets') IS NOT NULL THEN
    SELECT count(*) INTO n FROM (
      SELECT coalesce(tenant_id, school_id) FROM public.wallets
       GROUP BY 1 HAVING count(*) > 1) d;
    IF n > 0 THEN
      RAISE WARNING '% school(s) have more than one wallet. Review: SELECT coalesce(tenant_id, school_id) s, count(*), sum(balance) FROM public.wallets GROUP BY 1 HAVING count(*) > 1;', n;
    END IF;
  END IF;
END $$;

-- Reconciliation queries (run by hand):
--   Payments received but NOT credited (unmatched, wrong school, wrong currency):
--     SELECT * FROM school.payment_events WHERE outcome NOT IN ('credited','duplicate') ORDER BY received_at DESC;
--   Overpaid top-ups (paid more than requested; refund or credit manually):
--     SELECT * FROM school.payment_events WHERE outcome = 'credited' AND (detail->>'overpaid')::boolean;
--   Top-ups started but never paid:
--     SELECT * FROM school.payment_intents WHERE status = 'pending' AND created_at < now() - interval '1 day';
