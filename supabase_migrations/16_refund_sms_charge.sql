-- 16_refund_sms_charge.sql
--
-- Closes the last money hole in the SMS path: a message that was PAID for and
-- then could not be delivered. The sender now marks those rows
-- `error = 'charged_undelivered:<reason>'`; this function gives an operator a
-- safe way to give the money back.
--
-- Why not refund automatically inside the sender: a late delivery is still
-- possible after our last attempt (the gateway may have accepted the message
-- even when the response was lost). An automatic refund would then both deliver
-- the SMS and return the money. This is a deliberate, manual, idempotent action.
--
-- Idempotent: the refund is a ledger row with reference `sms_refund:<id>`, so a
-- second call returns { outcome: 'duplicate' } instead of crediting twice.
--
-- Usage (service_role only):
--   SELECT public.refund_sms_charge('<notification uuid>');
--   SELECT id, error FROM school.notifications
--    WHERE error LIKE 'charged_undelivered:%' AND sent_at IS NULL;

BEGIN;

CREATE OR REPLACE FUNCTION public.refund_sms_charge(
  p_notification_id text,
  p_reason          text DEFAULT 'charged but not delivered')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id        text := btrim(coalesce(p_notification_id, ''));
  v_debit_key text;
  v_refund    text;
  v_debit     public.transactions%ROWTYPE;
  v_amount    numeric;
  v_new       numeric;
BEGIN
  IF v_id = '' THEN
    RAISE EXCEPTION 'notification id is required' USING ERRCODE = '22023';
  END IF;

  v_debit_key := 'sms:' || v_id;
  v_refund := 'sms_refund:' || v_id;

  PERFORM pg_advisory_xact_lock(hashtext('smartskoolz.refund_sms'));

  IF EXISTS (SELECT 1 FROM public.transactions WHERE reference = v_refund) THEN
    RETURN jsonb_build_object('outcome', 'duplicate', 'reference', v_refund);
  END IF;

  SELECT * INTO v_debit
    FROM public.transactions
   WHERE reference = v_debit_key AND type = 'debit'
   LIMIT 1;

  IF NOT FOUND THEN
    -- Nothing was charged for this notification: nothing to refund.
    RETURN jsonb_build_object('outcome', 'no_charge', 'reference', v_debit_key);
  END IF;

  v_amount := abs(v_debit.amount);

  UPDATE public.wallets
     SET balance = coalesce(balance, 0) + v_amount,
         updated_at = now()
   WHERE id = v_debit.wallet_id
  RETURNING balance INTO v_new;

  IF v_new IS NULL THEN
    RAISE EXCEPTION 'wallet % not found' , v_debit.wallet_id USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.transactions (wallet_id, amount, type, reference, status, description)
  VALUES (v_debit.wallet_id, v_amount, 'credit', v_refund, 'completed',
          coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'SMS refund: charged but not delivered'));

  RETURN jsonb_build_object(
    'outcome', 'refunded',
    'amount', v_amount,
    'balance', v_new,
    'reference', v_refund,
    'original_reference', v_debit_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.refund_sms_charge(text, text) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.refund_sms_charge(text, text) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.refund_sms_charge(text, text) TO service_role;
  END IF;
END $$;

COMMIT;
