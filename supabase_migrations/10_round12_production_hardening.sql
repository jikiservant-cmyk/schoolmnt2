-- =============================================================================
-- 10_round12_production_hardening.sql
--
-- Round 12 Production Schema Reconciliation & Privilege Hardening.
-- Safe to re-run (100% idempotent).
--
-- Reconciles drift between application code and historical schemas across:
--   1. school.devices           (device_secret_hash, device_type, config, location_label)
--   2. school.device_commands   (vendor_protocol, acknowledged_at, error_message,
--                                completed_at, result, delivered_device_ids)
--   3. school.device_logs       (school_id, raw_serial_number, device_user_id,
--                                event_timestamp, processed, processed_at, processing_error)
--   4. school.person_credentials(credential_type, is_active + unique index
--                                (school_id, credential_type, identifier_value))
--   5. Secret-column privileges refreshed on school.staff_users and school.devices
--      (re-running the 04_rls_tenant_isolation.sql REVOKE/GRANT block so newly added
--      non-secret columns remain selectable by `authenticated` under RLS while
--      device_secret, device_secret_hash, pin_hash, failed_attempts, and locked_until
--      stay strictly server-only).
-- =============================================================================

BEGIN;

-- 1. school.devices -----------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('school.devices') IS NOT NULL THEN
    ALTER TABLE school.devices ADD COLUMN IF NOT EXISTS device_secret_hash text;
    ALTER TABLE school.devices ADD COLUMN IF NOT EXISTS device_type text DEFAULT 'zkteco_adms';
    ALTER TABLE school.devices ADD COLUMN IF NOT EXISTS config jsonb DEFAULT '{}'::jsonb;
    ALTER TABLE school.devices ADD COLUMN IF NOT EXISTS location_label text;

    -- Backfill SHA-256 hash from legacy plaintext device_secret if missing.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'school' AND table_name = 'devices' AND column_name = 'device_secret'
    ) THEN
      UPDATE school.devices
      SET device_secret_hash = encode(pg_catalog.sha256(convert_to(device_secret, 'UTF8')), 'hex')
      WHERE device_secret IS NOT NULL
        AND btrim(device_secret) <> ''
        AND device_secret_hash IS NULL;
    END IF;
  END IF;
END $$;

-- 2. school.device_commands ---------------------------------------------------
DO $$
BEGIN
  IF to_regclass('school.device_commands') IS NOT NULL THEN
    ALTER TABLE school.device_commands ADD COLUMN IF NOT EXISTS vendor_protocol text DEFAULT 'zkteco_adms';
    ALTER TABLE school.device_commands ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
    ALTER TABLE school.device_commands ADD COLUMN IF NOT EXISTS error_message text;
    ALTER TABLE school.device_commands ADD COLUMN IF NOT EXISTS completed_at timestamptz;
    ALTER TABLE school.device_commands ADD COLUMN IF NOT EXISTS result text;
    ALTER TABLE school.device_commands ADD COLUMN IF NOT EXISTS delivered_device_ids text[] NOT NULL DEFAULT '{}'::text[];
  END IF;
END $$;

-- 3. school.device_logs -------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('school.device_logs') IS NOT NULL THEN
    IF to_regclass('school.schools') IS NOT NULL THEN
      ALTER TABLE school.device_logs ADD COLUMN IF NOT EXISTS school_id uuid REFERENCES school.schools(id);
    ELSE
      ALTER TABLE school.device_logs ADD COLUMN IF NOT EXISTS school_id uuid;
    END IF;
    ALTER TABLE school.device_logs ADD COLUMN IF NOT EXISTS raw_serial_number text;
    ALTER TABLE school.device_logs ADD COLUMN IF NOT EXISTS device_user_id text;
    ALTER TABLE school.device_logs ADD COLUMN IF NOT EXISTS event_timestamp timestamptz DEFAULT now();
    ALTER TABLE school.device_logs ADD COLUMN IF NOT EXISTS processed boolean DEFAULT false;
    ALTER TABLE school.device_logs ADD COLUMN IF NOT EXISTS processed_at timestamptz;
    ALTER TABLE school.device_logs ADD COLUMN IF NOT EXISTS processing_error text;
  END IF;
END $$;

-- 4. school.person_credentials ------------------------------------------------
DO $$
BEGIN
  IF to_regclass('school.person_credentials') IS NOT NULL THEN
    ALTER TABLE school.person_credentials ADD COLUMN IF NOT EXISTS credential_type text DEFAULT 'pin';
    ALTER TABLE school.person_credentials ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'school' AND table_name = 'person_credentials' AND column_name = 'identifier_type'
    ) THEN
      UPDATE school.person_credentials
      SET credential_type = COALESCE(NULLIF(btrim(identifier_type), ''), 'pin')
      WHERE credential_type IS NULL;
    ELSE
      UPDATE school.person_credentials
      SET credential_type = 'pin'
      WHERE credential_type IS NULL;
    END IF;

    UPDATE school.person_credentials
    SET is_active = true
    WHERE is_active IS NULL;

    -- Deduplicate any pre-existing exact duplicates before enforcing the unique index.
    DELETE FROM school.person_credentials a
    USING school.person_credentials b
    WHERE a.ctid > b.ctid
      AND a.school_id IS NOT DISTINCT FROM b.school_id
      AND a.credential_type IS NOT DISTINCT FROM b.credential_type
      AND a.identifier_value IS NOT DISTINCT FROM b.identifier_value;

    CREATE UNIQUE INDEX IF NOT EXISTS person_credentials_school_type_val_uniq
      ON school.person_credentials (school_id, credential_type, identifier_value);
  END IF;
END $$;

-- 5. Secret columns: re-apply 04_rls_tenant_isolation.sql + 06_money_lockdown.sql grants --
-- Re-running this block after adding columns ensures:
--   a) secret columns (pin_hash, failed_attempts, locked_until, device_secret,
--      device_secret_hash) remain inaccessible to `authenticated` for both read & write;
--   b) newly added non-secret columns on `staff_users` and `devices` receive column
--      SELECT grants for `authenticated` so RLS queries never fail with 42501;
--   c) `staff_users` keeps zero client INSERT/UPDATE/DELETE grants per
--      `06_money_lockdown.sql` Section 5 (preventing teacher -> admin self-promotion).
DO $$
DECLARE
  spec record;
  cols text;
BEGIN
  IF to_regrole('authenticated') IS NULL THEN
    RAISE NOTICE 'role authenticated does not exist; skipping secret-column privilege refresh';
    RETURN;
  END IF;

  FOR spec IN SELECT * FROM (VALUES
      ('staff_users', ARRAY['pin_hash','failed_attempts','locked_until'], false),
      ('devices',     ARRAY['device_secret','device_secret_hash'],        true)) AS v(tbl, secret, allow_client_write)
  LOOP
    IF to_regclass('school.' || spec.tbl) IS NULL THEN CONTINUE; END IF;
    SELECT string_agg(quote_ident(column_name), ', ') INTO cols
    FROM information_schema.columns
    WHERE table_schema = 'school' AND table_name = spec.tbl AND column_name <> ALL (spec.secret);
    EXECUTE format('REVOKE SELECT ON school.%I FROM authenticated', spec.tbl);
    EXECUTE format('GRANT SELECT (%s) ON school.%I TO authenticated', cols, spec.tbl);
    -- Writes to secret columns are server-only; `staff_users` blocks all client writes per 06_money_lockdown.sql.
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON school.%I FROM anon, authenticated', spec.tbl);
    IF spec.allow_client_write THEN
      EXECUTE format('GRANT INSERT (%s), UPDATE (%s) ON school.%I TO authenticated', cols, cols, spec.tbl);
    END IF;
    RAISE NOTICE 'secret columns hidden on school.%: %', spec.tbl, spec.secret;
  END LOOP;
END $$;

COMMIT;
