-- =============================================================================
-- 10_auth_rbac_device_hardening.sql
--
-- Mandatory follow-up to 04/06/07.
--
-- 1. Makes the tenant resolver deterministic: one authenticated user maps to
--    exactly one school, otherwise it returns NULL (fail closed).
-- 2. Requires the server-controlled school_admin profile for every direct
--    PostgREST read/write in the school schema. This closes the gap where a
--    teacher's valid Supabase JWT could skip Next.js and use the anon key to
--    alter people, classes, devices, attendance, or device commands directly.
-- 3. Removes direct authenticated execution of application RPCs. Server
--    actions use the service-role client after their own auth check.
-- 4. Migrates legacy device plaintext/firmware secrets to hashes and keeps
--    secret material out of client-readable database fields.
--
-- Run after 04_rls_tenant_isolation.sql and 06_money_lockdown.sql.
-- =============================================================================

BEGIN;

-- Fail early instead of silently installing a partial authorization policy.
DO $$
BEGIN
  IF to_regclass('school.staff_users') IS NULL THEN
    RAISE EXCEPTION '10_auth_rbac_device_hardening: school.staff_users is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'school' AND table_name = 'staff_users' AND column_name = 'auth_user_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'school' AND table_name = 'staff_users' AND column_name = 'school_id'
  ) THEN
    RAISE EXCEPTION '10_auth_rbac_device_hardening: staff_users must contain auth_user_id and school_id';
  END IF;
  IF to_regclass('public.admin_profiles') IS NULL THEN
    RAISE EXCEPTION '10_auth_rbac_device_hardening: public.admin_profiles is required';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'admin_profiles'
        AND column_name IN ('id', 'role', 'app_type', 'school_id')) <> 4 THEN
    RAISE EXCEPTION '10_auth_rbac_device_hardening: admin_profiles must contain id, role, app_type and school_id';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- A. Device-secret storage and legacy metadata cleanup
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF to_regclass('school.devices') IS NULL THEN
    RAISE NOTICE '10: school.devices does not exist; device secret migration skipped';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'school' AND table_name = 'devices' AND column_name = 'serial_number'
  ) THEN
    RAISE EXCEPTION '10_auth_rbac_device_hardening: devices must contain serial_number';
  END IF;

  ALTER TABLE school.devices ADD COLUMN IF NOT EXISTS device_secret text;
  ALTER TABLE school.devices ADD COLUMN IF NOT EXISTS device_secret_hash text;

  -- Convert any dedicated legacy plaintext secret before clearing it. SHA-256
  -- is appropriate here because generated device credentials contain 128 bits
  -- of CSPRNG entropy; new credentials are always generated server-side.
  UPDATE school.devices
     SET device_secret_hash = encode(digest(device_secret, 'sha256'), 'hex'),
         device_secret = NULL
   WHERE nullif(btrim(device_secret), '') IS NOT NULL
     AND nullif(btrim(device_secret_hash), '') IS NULL;

  -- Do not leave a duplicate cleartext after a previous partial migration.
  UPDATE school.devices
     SET device_secret = NULL
   WHERE nullif(btrim(device_secret), '') IS NOT NULL
     AND nullif(btrim(device_secret_hash), '') IS NOT NULL;
END
$$;

-- Old deployments occasionally packed {"secret":"..."} into firmware_version.
-- Parse each row defensively: malformed metadata is left intact (the app strips
-- it from client output), while valid metadata is rewritten with secret removed.
DO $$
DECLARE
  row_record record;
  metadata jsonb;
  legacy_secret text;
  firmware_base text;
BEGIN
  IF to_regclass('school.devices') IS NULL THEN RETURN; END IF;

  FOR row_record IN
    SELECT id, firmware_version, device_secret_hash
    FROM school.devices
    WHERE firmware_version LIKE '%|META:%'
  LOOP
    BEGIN
      firmware_base := split_part(row_record.firmware_version, '|META:', 1);
      metadata := split_part(row_record.firmware_version, '|META:', 2)::jsonb;
      legacy_secret := nullif(btrim(metadata ->> 'secret'), '');

      IF legacy_secret IS NOT NULL THEN
        UPDATE school.devices
           SET device_secret_hash = coalesce(
                 nullif(btrim(device_secret_hash), ''),
                 encode(digest(legacy_secret, 'sha256'), 'hex')
               ),
               firmware_version = firmware_base || '|META:' || (metadata - 'secret')::text
         WHERE id = row_record.id;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING '10: could not parse packed metadata for device %; rotate it from the dashboard', row_record.id;
    END;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF to_regclass('school.devices') IS NULL THEN RETURN; END IF;
  REVOKE SELECT (device_secret, device_secret_hash) ON school.devices FROM authenticated;
  REVOKE INSERT (device_secret, device_secret_hash), UPDATE (device_secret, device_secret_hash)
    ON school.devices FROM authenticated;

  -- Authentication locates a device by serial before checking its credential;
  -- serials must therefore be globally unique, not merely unique per school.
  IF EXISTS (
    SELECT 1
    FROM school.devices
    WHERE nullif(btrim(serial_number), '') IS NOT NULL
    GROUP BY upper(btrim(serial_number))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '10: duplicate normalized device serials exist; resolve them before enabling gateway authentication';
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('school.devices') IS NOT NULL THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS devices_serial_number_normalized_unique '
      || 'ON school.devices (upper(btrim(serial_number))) '
      || 'WHERE nullif(btrim(serial_number), '''') IS NOT NULL';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- B. Deterministic identity and role predicates
-- -----------------------------------------------------------------------------
-- This app has no tenant switcher. A user with zero or multiple school staff
-- memberships is therefore denied rather than receiving whichever LIMIT 1 row
-- the planner happens to return.
CREATE OR REPLACE FUNCTION school.auth_school_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, school
AS $$
  SELECT CASE WHEN count(DISTINCT su.school_id) = 1
              THEN (array_agg(DISTINCT su.school_id))[1]
              ELSE NULL
         END
  FROM school.staff_users AS su
  WHERE su.auth_user_id = auth.uid()
    AND su.school_id IS NOT NULL
$$;

-- The application profile is server-controlled (migration 06); user_metadata
-- is never consulted. A NULL profile.school_id is permitted only for existing
-- records awaiting backfill. An explicit conflicting school_id is denied.
CREATE OR REPLACE FUNCTION school.is_school_admin(p_school_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, school
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_profiles AS ap
    WHERE ap.id = auth.uid()
      AND ap.role = 'school_admin'
      AND (ap.app_type IS NULL OR ap.app_type = 'school')
      AND (p_school_id IS NULL OR ap.school_id IS NULL OR ap.school_id = p_school_id)
  )
$$;

REVOKE ALL ON FUNCTION school.auth_school_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION school.is_school_admin(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION school.auth_school_id() FROM anon;
    REVOKE ALL ON FUNCTION school.is_school_admin(uuid) FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION school.auth_school_id() TO authenticated;
    GRANT EXECUTE ON FUNCTION school.is_school_admin(uuid) TO authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION school.auth_school_id() TO service_role;
    GRANT EXECUTE ON FUNCTION school.is_school_admin(uuid) TO service_role;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- C. School-table RBAC: tenant ownership AND school_admin are both required
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'people', 'classes', 'academic_years', 'devices', 'device_commands',
    'device_logs', 'attendance_logs', 'parents', 'person_credentials',
    'notifications', 'staff_users'
  ]
  LOOP
    IF to_regclass('school.' || t) IS NULL OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'school' AND table_name = t AND column_name = 'school_id'
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE school.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_access ON school.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_guard ON school.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_access ON school.%I AS PERMISSIVE FOR ALL TO authenticated '
      || 'USING (school.is_school_admin(school_id) AND school_id = school.auth_school_id()) '
      || 'WITH CHECK (school.is_school_admin(school_id) AND school_id = school.auth_school_id())',
      t
    );
    EXECUTE format(
      'CREATE POLICY tenant_guard ON school.%I AS RESTRICTIVE FOR ALL TO authenticated '
      || 'USING (school.is_school_admin(school_id) AND school_id = school.auth_school_id()) '
      || 'WITH CHECK (school.is_school_admin(school_id) AND school_id = school.auth_school_id())',
      t
    );
  END LOOP;
END
$$;

DO $$
BEGIN
  IF to_regclass('school.student_parents') IS NOT NULL THEN
    ALTER TABLE school.student_parents ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_access ON school.student_parents;
    DROP POLICY IF EXISTS tenant_guard ON school.student_parents;
    CREATE POLICY tenant_access ON school.student_parents AS PERMISSIVE FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM school.people AS p
          WHERE p.id = student_id
            AND p.school_id = school.auth_school_id()
            AND school.is_school_admin(p.school_id)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM school.people AS p
          WHERE p.id = student_id
            AND p.school_id = school.auth_school_id()
            AND school.is_school_admin(p.school_id)
        )
      );
    CREATE POLICY tenant_guard ON school.student_parents AS RESTRICTIVE FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM school.people AS p
          WHERE p.id = student_id
            AND p.school_id = school.auth_school_id()
            AND school.is_school_admin(p.school_id)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM school.people AS p
          WHERE p.id = student_id
            AND p.school_id = school.auth_school_id()
            AND school.is_school_admin(p.school_id)
        )
      );
  END IF;

  -- Older deployments did not store school_id on device_logs. It must still
  -- be protected through its device FK; otherwise an authenticated teacher can
  -- query every school's raw biometric events via PostgREST.
  IF to_regclass('school.device_logs') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'school' AND table_name = 'device_logs' AND column_name = 'school_id'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'school' AND table_name = 'device_logs' AND column_name = 'device_id'
     ) THEN
    ALTER TABLE school.device_logs ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_access ON school.device_logs;
    DROP POLICY IF EXISTS tenant_guard ON school.device_logs;
    CREATE POLICY tenant_access ON school.device_logs AS PERMISSIVE FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM school.devices AS d
          WHERE d.id = device_id
            AND d.school_id = school.auth_school_id()
            AND school.is_school_admin(d.school_id)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM school.devices AS d
          WHERE d.id = device_id
            AND d.school_id = school.auth_school_id()
            AND school.is_school_admin(d.school_id)
        )
      );
    CREATE POLICY tenant_guard ON school.device_logs AS RESTRICTIVE FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM school.devices AS d
          WHERE d.id = device_id
            AND d.school_id = school.auth_school_id()
            AND school.is_school_admin(d.school_id)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM school.devices AS d
          WHERE d.id = device_id
            AND d.school_id = school.auth_school_id()
            AND school.is_school_admin(d.school_id)
        )
      );
  END IF;

  IF to_regclass('school.schools') IS NOT NULL THEN
    ALTER TABLE school.schools ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_access ON school.schools;
    DROP POLICY IF EXISTS tenant_guard ON school.schools;
    CREATE POLICY tenant_access ON school.schools AS PERMISSIVE FOR SELECT TO authenticated
      USING (school.is_school_admin(id) AND id = school.auth_school_id());
    CREATE POLICY tenant_guard ON school.schools AS RESTRICTIVE FOR ALL TO authenticated
      USING (school.is_school_admin(id) AND id = school.auth_school_id())
      WITH CHECK (school.is_school_admin(id) AND id = school.auth_school_id());
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- D. Public money/tenant reads are admin-only as well
-- -----------------------------------------------------------------------------
DO $$
DECLARE wallet_condition text; tx_wallet_condition text;
BEGIN
  IF to_regclass('public.wallets') IS NOT NULL THEN
    SELECT string_agg(format('%I = school.auth_school_id()', column_name), ' OR ')
      INTO wallet_condition
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'wallets'
       AND column_name IN ('tenant_id', 'school_id');

    IF wallet_condition IS NOT NULL THEN
      ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS school_wallet_read ON public.wallets;
      DROP POLICY IF EXISTS school_wallet_admin_guard ON public.wallets;
      EXECUTE 'CREATE POLICY school_wallet_read ON public.wallets AS PERMISSIVE FOR SELECT TO authenticated '
        || 'USING (school.is_school_admin(school.auth_school_id()) AND (' || wallet_condition || '))';
      EXECUTE 'CREATE POLICY school_wallet_admin_guard ON public.wallets AS RESTRICTIVE FOR SELECT TO authenticated '
        || 'USING (school.is_school_admin(school.auth_school_id()) AND (' || wallet_condition || '))';
    END IF;
  END IF;

  IF to_regclass('public.transactions') IS NOT NULL
     AND to_regclass('public.wallets') IS NOT NULL THEN
    SELECT string_agg(format('w.%I = school.auth_school_id()', column_name), ' OR ')
      INTO tx_wallet_condition
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'wallets'
       AND column_name IN ('tenant_id', 'school_id');

    IF tx_wallet_condition IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'wallet_id'
       ) THEN
      ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS school_tx_read ON public.transactions;
      DROP POLICY IF EXISTS school_tx_admin_guard ON public.transactions;
      EXECUTE 'CREATE POLICY school_tx_read ON public.transactions AS PERMISSIVE FOR SELECT TO authenticated '
        || 'USING (school.is_school_admin(school.auth_school_id()) AND EXISTS ('
        || 'SELECT 1 FROM public.wallets AS w WHERE w.id = wallet_id AND (' || tx_wallet_condition || ')))';
      EXECUTE 'CREATE POLICY school_tx_admin_guard ON public.transactions AS RESTRICTIVE FOR SELECT TO authenticated '
        || 'USING (school.is_school_admin(school.auth_school_id()) AND EXISTS ('
        || 'SELECT 1 FROM public.wallets AS w WHERE w.id = wallet_id AND (' || tx_wallet_condition || ')))';
    END IF;
  END IF;

  IF to_regclass('public.tenants') IS NOT NULL THEN
    ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS own_tenant_read ON public.tenants;
    DROP POLICY IF EXISTS school_tenant_admin_guard ON public.tenants;
    CREATE POLICY own_tenant_read ON public.tenants AS PERMISSIVE FOR SELECT TO authenticated
      USING (id = school.auth_school_id() AND school.is_school_admin(id));
    CREATE POLICY school_tenant_admin_guard ON public.tenants AS RESTRICTIVE FOR SELECT TO authenticated
      USING (id = school.auth_school_id() AND school.is_school_admin(id));
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- E. Direct application RPCs are server-only
-- -----------------------------------------------------------------------------
-- The browser has the anon key and every authenticated JWT can call exposed
-- RPCs directly. The app invokes only auth_school_id() as the user; all other
-- school functions must run through a Server Action after requireSchoolAdmin.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'school'
      AND p.prokind = 'f'
      AND p.proname NOT IN ('auth_school_id', 'is_school_admin')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend AS d WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.signature);
    IF to_regrole('anon') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f.signature);
    END IF;
    IF to_regrole('authenticated') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f.signature);
    END IF;
    IF to_regrole('service_role') IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.signature);
    END IF;
  END LOOP;
END
$$;

COMMIT;

-- Post-deployment verification:
--   1. A normal teacher JWT must get zero rows / permission errors from
--      /rest/v1/people, /classes, /devices and /rpc/fn_add_person.
--   2. A school_admin JWT must still see only its own rows.
--   3. Rotate every terminal that was using the temporary global secret, then
--      remove ZKTECO_ALLOW_LEGACY_GLOBAL_SECRET from the deployment.
