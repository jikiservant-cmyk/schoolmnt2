-- =============================================================================
-- 07_payment_hardening.sql: money round 4 (see SECURITY_AUDIT.md Part 7)
-- =============================================================================
-- Run AFTER 05 and 06. Idempotent.
--  1. apply_payment no longer re-seeds a wallet from the stale legacy
--     school.schools.settings.balance once the school has been credited.
--  2. Signup / provisioning functions (rp_create_school_from_admin_profile,
--     anything *create_school* / *provision* / *onboard* / rp_*) become
--     server-only: the app calls them with the service_role key, but Supabase
--     lets PUBLIC (the anon key) execute every new function by default.
--  3. Functions in the `school` schema: never executable by the anon key.
--  4. A wallet that still holds money can't be deleted (move the balance to
--     the surviving wallet first, e.g. when merging duplicate wallets).
-- =============================================================================

-- 1. ---------------------------------------------------------------------------
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

  -- 1. Match the payment to a top-up the app started: by our reference (NaJiki
  --    echoes it in metadata.idempotencyKey), or by NaJiki's paymentId, which
  --    the app stores on the intent when NaJiki accepts the request...
  SELECT * INTO v_intent FROM school.payment_intents
   WHERE reference = ANY (v_refs)
      OR (provider_ref IS NOT NULL AND (provider_ref = ANY (v_refs) OR provider_ref = p_provider_ref))
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
    -- 07: ONLY for a school this function has never credited. After the first
    -- credit settings.balance is just a mirror that SMS spending never lowers;
    -- re-seeding from it after a wallet row was deleted (e.g. duplicate-wallet
    -- cleanup) minted the stale amount.
    v_legacy := NULL;
    IF NOT EXISTS (SELECT 1 FROM school.payment_events WHERE school_id = v_school AND outcome = 'credited') THEN
    SELECT CASE WHEN (settings->>'balance') ~ '^[0-9]+(\.[0-9]+)?$'
                THEN (settings->>'balance')::numeric ELSE 0 END
      INTO v_legacy FROM school.schools WHERE id = v_school;
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

  -- Keep the legacy mirror equal to the wallet (not incremented separately).
  UPDATE school.schools
     SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{balance}', to_jsonb(v_bal))
   WHERE id = v_school;

  IF v_intent.id IS NOT NULL THEN
    UPDATE school.payment_intents
       SET status = 'credited', credited_amount = v_credit, credited_at = now(),
           provider_ref = coalesce(provider_ref, p_provider_ref)
     WHERE id = v_intent.id;
  END IF;

  PERFORM school.log_payment_event('credited', v_key, p_provider_ref, v_intent.id, v_school, p_amount, v_credit, v_cur,
    p_detail || jsonb_build_object('overpaid', p_amount > v_credit));
  RETURN jsonb_build_object('outcome', 'credited', 'school_id', v_school, 'amount', v_credit,
                            'reported_amount', p_amount, 'balance', v_bal, 'reference', v_key);
END;
$$;

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

-- 2. Provisioning functions: server only ----------------------------------------
DO $$
DECLARE f record; has_sr boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'school') AND p.prokind = 'f'
      AND (p.proname ~* '(create_school|provision|onboard)' OR p.proname ~* '^rp_')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f.sig);
    END IF;
    IF has_sr THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig); END IF;
    RAISE NOTICE 'server-only provisioning function: %', f.sig;
  END LOOP;
END $$;

-- 3. school schema: nothing executable by the anon key --------------------------
-- Logged-in users keep what they had (school.auth_school_id used by RLS,
-- school.fn_add_person used by the People page). Money / provisioning
-- functions (06, and step 2 above) stay server-only.
DO $$
DECLARE f record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN RETURN; END IF;
  FOR f IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'school' AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    IF f.proname !~* '(wallet|credit|debit|balance|payment|topup|top_up|charge|refund|deduct|ledger|sms|create_school|provision|onboard)'
       AND f.proname !~* '^rp_'
       AND has_function_privilege('authenticated', f.sig, 'EXECUTE') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f.sig);
  END LOOP;
  RAISE NOTICE 'school schema functions: anon EXECUTE removed';
END $$;

-- 4. Never delete a wallet that still holds money -------------------------------
-- Deleting it would make the school's credit vanish (and, before step 1, let
-- the next top-up re-mint a stale legacy balance). Merge duplicates by moving
-- the balance first:  UPDATE wallets SET balance = balance + <x> WHERE id = <keep>;
--                     UPDATE wallets SET balance = 0 WHERE id = <drop>; DELETE ...
CREATE OR REPLACE FUNCTION school.guard_wallet_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(OLD.balance, 0) <> 0 THEN
    RAISE EXCEPTION 'wallet % still holds % UGX: move the balance to another wallet of the same school before deleting it', OLD.id, OLD.balance
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION school.guard_wallet_delete() FROM PUBLIC;
DO $$ BEGIN
  IF to_regclass('public.wallets') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS wallets_no_delete_with_balance ON public.wallets;
    CREATE TRIGGER wallets_no_delete_with_balance BEFORE DELETE ON public.wallets
      FOR EACH ROW EXECUTE FUNCTION school.guard_wallet_delete();
  END IF;
END $$;
