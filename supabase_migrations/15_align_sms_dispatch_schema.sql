-- 15_align_sms_dispatch_schema.sql
--
-- Align this repository with the LIVE Supabase project.
--
-- The Edge Function that actually runs there (`send-attendance-sms`) was written
-- against a schema this repo never produced. Rather than "fix" the function to
-- match the repo, this migration brings the repo up to the live shape:
--
--   school.notifications.retry_count    integer   (attempt counter)
--   school.notifications.next_retry_at  timestamptz (claim lock + backoff)
--   school.notifications.error          text      (last failure code)
--   school.notifications.status         default 'pending'
--   school.notifications.provider_response  text  (the function stores JSON text)
--   public.debit_sms_wallet(p_wallet_id text, p_amount numeric,
--                           p_idempotency_key text, p_tenant_id text,
--                           p_description text)
--
-- Everything is idempotent, so it can be applied to a database that already has
-- these objects (the live project) or to a fresh one built from `05`..`14`.
--
-- NOTE: this migration does NOT drop `school.notifications.provider_ref`. The
-- live project does not have that column, but the app's delivery webhook already
-- handles its absence (it falls back to matching the notification id), so
-- keeping it on a fresh install is harmless and non-destructive.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Notification dispatch columns
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('school.notifications') IS NULL THEN
    RAISE NOTICE 'school.notifications not found; nothing to align';
    RETURN;
  END IF;

  ALTER TABLE school.notifications ADD COLUMN IF NOT EXISTS retry_count integer;
  ALTER TABLE school.notifications ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
  ALTER TABLE school.notifications ADD COLUMN IF NOT EXISTS error text;

  UPDATE school.notifications SET retry_count = 0 WHERE retry_count IS NULL;
  ALTER TABLE school.notifications ALTER COLUMN retry_count SET DEFAULT 0;
  ALTER TABLE school.notifications ALTER COLUMN retry_count SET NOT NULL;

  -- The live project defaults new rows to 'pending'; the app also sets it
  -- explicitly, so this only matters for rows inserted by other tooling.
  ALTER TABLE school.notifications ALTER COLUMN status SET DEFAULT 'pending';

  -- provider_response is `text` in production (the sender writes JSON text).
  -- Migration 11 created it as jsonb, so convert it where that happened.
  ALTER TABLE school.notifications ADD COLUMN IF NOT EXISTS provider_response text;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'school' AND table_name = 'notifications'
       AND column_name = 'provider_response' AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE school.notifications
      ALTER COLUMN provider_response TYPE text USING provider_response::text;
  END IF;
END $$;

-- The retry sweep filters on exactly this.
CREATE INDEX IF NOT EXISTS notifications_pending_due_idx
  ON school.notifications (status, next_retry_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- 2. public.debit_sms_wallet — the live signature the Edge Function calls
-- ---------------------------------------------------------------------------
--
-- Contract, as used by `send-attendance-sms`:
--   * p_wallet_id        the wallet row id (text, cast here)
--   * p_amount           whole UGX amount, must be > 0
--   * p_idempotency_key  one key per SMS: `sms:<notification_id>`
--   * p_tenant_id        the school, checked against the wallet so a wrong or
--                        hostile call cannot debit someone else's wallet
--   * p_description      free text for the ledger
--
-- It raises on insufficient funds, because the sender treats a non-null error
-- as "do not send" and a success as "money moved". It never double-charges: an
-- existing `public.transactions.reference` with the same idempotency key is a
-- no-op that returns { outcome: 'duplicate' }.
CREATE OR REPLACE FUNCTION public.debit_sms_wallet(
  p_wallet_id       text,
  p_amount          numeric,
  p_idempotency_key text,
  p_tenant_id       text,
  p_description     text DEFAULT 'SMS Notification Charge')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_wallet_id uuid;
  v_tenant_id uuid;
  v_key       text := btrim(coalesce(p_idempotency_key, ''));
  v_balance   numeric;
  v_new       numeric;
BEGIN
  IF v_key = '' OR length(v_key) > 200 THEN
    RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> trunc(p_amount) THEN
    RAISE EXCEPTION 'invalid amount' USING ERRCODE = '22023';
  END IF;
  IF btrim(coalesce(p_wallet_id, '')) = '' THEN
    RAISE EXCEPTION 'wallet id is required' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_wallet_id := btrim(p_wallet_id)::uuid;
    v_tenant_id := nullif(btrim(coalesce(p_tenant_id, '')), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid uuid' USING ERRCODE = '22023';
  END;

  -- One SMS, one charge, forever.
  IF EXISTS (SELECT 1 FROM public.transactions WHERE reference = v_key) THEN
    RETURN jsonb_build_object('outcome', 'duplicate', 'idempotency_key', v_key);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('smartskoolz.apply_payment'));

  SELECT coalesce(balance, 0) INTO v_balance
    FROM public.wallets
   WHERE id = v_wallet_id
     AND (v_tenant_id IS NULL OR tenant_id = v_tenant_id OR school_id = v_tenant_id)
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet not found for tenant' USING ERRCODE = '22023';
  END IF;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'insufficient balance' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.wallets SET balance = v_balance - p_amount, updated_at = now()
   WHERE id = v_wallet_id
  RETURNING balance INTO v_new;

  INSERT INTO public.transactions (wallet_id, amount, type, reference, status, description)
  VALUES (v_wallet_id, -p_amount, 'debit', v_key, 'completed',
          coalesce(nullif(btrim(coalesce(p_description, '')), ''), 'SMS Notification Charge'));

  RETURN jsonb_build_object('outcome', 'debited', 'balance', v_new, 'amount', p_amount);
END;
$$;

REVOKE ALL ON FUNCTION public.debit_sms_wallet(text, numeric, text, text, text) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.debit_sms_wallet(text, numeric, text, text, text) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.debit_sms_wallet(text, numeric, text, text, text) TO service_role;
  END IF;
END $$;

COMMIT;
