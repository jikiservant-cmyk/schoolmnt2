-- =============================================================================
-- 08_payment_retry_dedupe.sql: money round 5 (see SECURITY_AUDIT.md Part 9)
-- =============================================================================
-- Run AFTER 05, 06 and 07. Idempotent. Same apply_payment as 07, plus:
--  * every credited payment remembers ALL references it arrived with
--    (payment_events.detail.refs), and
--  * any later notification carrying one of those references is a duplicate.
-- Found by the reconciliation test: a payment notification that lacked our
-- top-up reference was matched to the school's oldest pending top-up of the
-- same amount (correct), but NaJiki's RETRY of it then matched the NEXT
-- pending top-up of that amount: one payment, credited twice.
-- =============================================================================

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

  -- 08: a notification re-sent with ANY reference already seen on a credited
  -- payment (our reference, NaJiki's reference / paymentIntentId, the mobile
  -- money transaction id) is the same payment. Before, a retry of a
  -- notification WITHOUT our reference fell through to the "oldest pending
  -- top-up of this amount" match and credited the NEXT pending top-up.
  IF p_provider_ref IS NOT NULL AND NOT (p_provider_ref = ANY (v_refs)) THEN
    v_refs := v_refs || p_provider_ref;
  END IF;
  IF cardinality(v_refs) > 0 AND EXISTS (
       SELECT 1 FROM school.payment_events
        WHERE outcome = 'credited' AND (detail -> 'refs') ?| v_refs) THEN
    PERFORM school.log_payment_event('duplicate', v_refs[1], p_provider_ref, NULL, p_claimed_school, p_amount, NULL, v_cur, p_detail);
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
    p_detail || jsonb_build_object('overpaid', p_amount > v_credit, 'refs', to_jsonb(v_refs)));
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


-- Backfill: payments credited before this migration remember their known refs.
UPDATE school.payment_events
   SET detail = coalesce(detail, '{}'::jsonb)
                || jsonb_build_object('refs', to_jsonb(array_remove(ARRAY[idempotency_key, provider_ref], NULL)))
 WHERE outcome = 'credited' AND NOT (coalesce(detail, '{}'::jsonb) ? 'refs');

CREATE INDEX IF NOT EXISTS payment_events_credited_refs_gin
  ON school.payment_events USING gin ((detail -> 'refs')) WHERE outcome = 'credited';

DO $$ BEGIN RAISE NOTICE '08: apply_payment now refuses re-sent payments by any known reference'; END $$;
