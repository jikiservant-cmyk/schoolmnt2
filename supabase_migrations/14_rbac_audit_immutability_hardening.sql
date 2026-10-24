-- =============================================================================
-- Migration 14: Intra-Tenant RBAC Lockdown & Immutable Attendance Audit Hardening
--
-- Found & verified during Full-Branch Penetration Testing on `arena/d26e99f0-schoolmnt2`:
--
--   1. [HIGH] Vertical Privilege Escalation by Non-Admin Staff (`staff_role != 'admin'`):
--      `04_rls_tenant_isolation.sql` gated `school.*` tables only on
--      `school_id = school.auth_school_id()` without checking whether `auth.uid()`
--      is an authorized `school_admin`. Non-admin staff JWTs (e.g. `teacher`)
--      blocked from `/dashboard` in Next.js could bypass the app and call
--      Supabase PostgREST directly to read/modify/delete school records, hijack
--      parent phone numbers, or queue raw biometric terminal commands.
--      -> Fixed via `school.is_school_admin()` RESTRICTIVE RLS enforcement across
--         all `school.*` tenant tables and `public.wallets` / `transactions` / `tenants`.
--
--   2. [HIGH] Audit Log Destruction via Stolen Browser Token:
--      No browser flow ever deletes `school.attendance_logs` or writes/deletes
--      `school.device_logs`, yet `authenticated` held those privileges.
--      -> Revoked `DELETE, TRUNCATE` on `school.attendance_logs` and
--         `INSERT, UPDATE, DELETE, TRUNCATE` on `school.device_logs` from
--         `anon` and `authenticated` (`service_role` retains full access).
--
--   3. [MEDIUM] Arbitrary `status` Values on `school.attendance_logs`:
--      -> Enforces `CHECK (status IN ('present', 'late', 'absent', 'excused'))`.
--
-- 100% idempotent & standalone — safe to run once or re-run anytime in Supabase.
-- =============================================================================

BEGIN;

-- 1. Authoritative server-side check: is `auth.uid()` a verified `school_admin`
--    for `school.auth_school_id()`? Never trusts `user_metadata`.
CREATE OR REPLACE FUNCTION school.is_school_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, school, public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_school uuid := school.auth_school_id();
  v_ok boolean := false;
BEGIN
  IF v_uid IS NULL OR v_school IS NULL THEN
    RETURN false;
  END IF;

  -- Check `public.admin_profiles` (canonical source enforced by Next.js middleware & login)
  IF to_regclass('public.admin_profiles') IS NOT NULL THEN
    EXECUTE $q$
      SELECT EXISTS (
        SELECT 1
          FROM public.admin_profiles ap
         WHERE ap.id = $1
           AND ap.school_id = $2
           AND ap.role = 'school_admin'
      )
    $q$ INTO v_ok USING v_uid, v_school;
    IF v_ok THEN RETURN true; END IF;
  END IF;

  -- Check `public.profiles` if used in shared multi-app schemas
  IF to_regclass('public.profiles') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'role'
  ) THEN
    EXECUTE $q$
      SELECT EXISTS (
        SELECT 1
          FROM public.profiles pr
         WHERE pr.id = $1
           AND pr.role = 'school_admin'
      )
    $q$ INTO v_ok USING v_uid;
    IF v_ok THEN RETURN true; END IF;
  END IF;

  -- Check `school.staff_users` explicit `admin` staff role
  IF to_regclass('school.staff_users') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM school.staff_users su
       WHERE su.auth_user_id = v_uid
         AND su.school_id = v_school
         AND su.staff_role = 'admin'
    ) INTO v_ok;
    IF v_ok THEN RETURN true; END IF;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION school.is_school_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION school.is_school_admin() TO authenticated, service_role;

-- 2. Enforce RESTRICTIVE `school.is_school_admin()` guard across every `school.*` table
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'people',
    'classes',
    'academic_years',
    'devices',
    'device_commands',
    'device_logs',
    'attendance_logs',
    'parents',
    'person_credentials',
    'notifications',
    'staff_users'
  ]
  LOOP
    IF to_regclass('school.' || t) IS NULL OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'school' AND table_name = t AND column_name = 'school_id'
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE school.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rbac_school_admin_only ON school.%I', t);
    EXECUTE format(
      'CREATE POLICY rbac_school_admin_only ON school.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING (school_id = school.auth_school_id() AND school.is_school_admin()) '
      'WITH CHECK (school_id = school.auth_school_id() AND school.is_school_admin())',
      t
    );
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('school.student_parents') IS NOT NULL THEN
    ALTER TABLE school.student_parents ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rbac_school_admin_only ON school.student_parents;
    CREATE POLICY rbac_school_admin_only ON school.student_parents
      AS RESTRICTIVE FOR ALL TO authenticated
      USING (
        school.is_school_admin()
        AND EXISTS (
          SELECT 1 FROM school.people p
           WHERE p.id = student_id AND p.school_id = school.auth_school_id()
        )
      )
      WITH CHECK (
        school.is_school_admin()
        AND EXISTS (
          SELECT 1 FROM school.people p
           WHERE p.id = student_id AND p.school_id = school.auth_school_id()
        )
      );
  END IF;

  IF to_regclass('school.schools') IS NOT NULL THEN
    ALTER TABLE school.schools ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rbac_school_admin_only ON school.schools;
    CREATE POLICY rbac_school_admin_only ON school.schools
      AS RESTRICTIVE FOR ALL TO authenticated
      USING (id = school.auth_school_id() AND school.is_school_admin())
      WITH CHECK (id = school.auth_school_id() AND school.is_school_admin());
  END IF;

  IF to_regclass('school.school_settings') IS NOT NULL THEN
    ALTER TABLE school.school_settings ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rbac_school_admin_only ON school.school_settings;
    CREATE POLICY rbac_school_admin_only ON school.school_settings
      AS RESTRICTIVE FOR ALL TO authenticated
      USING (school_id = school.auth_school_id() AND school.is_school_admin())
      WITH CHECK (school_id = school.auth_school_id() AND school.is_school_admin());
  END IF;
END $$;

-- Also block non-admin staff JWTs from reading `public.wallets`, `public.transactions`, `public.tenants`
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wallets', 'transactions', 'tenants'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rbac_school_admin_only ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY rbac_school_admin_only ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated '
      'USING (school.is_school_admin())',
      t
    );
  END LOOP;
END $$;

-- 3. Audit Trail Immutability:
--    - `school.attendance_logs`: never deletable or truncatable by client tokens
--    - `school.device_logs`: strictly read-only for `school_admin`, writeable ONLY by `service_role`
DO $$
BEGIN
  IF to_regclass('school.attendance_logs') IS NOT NULL THEN
    REVOKE DELETE, TRUNCATE ON TABLE school.attendance_logs FROM PUBLIC;
    IF to_regrole('anon') IS NOT NULL THEN
      REVOKE DELETE, TRUNCATE ON TABLE school.attendance_logs FROM anon;
    END IF;
    IF to_regrole('authenticated') IS NOT NULL THEN
      REVOKE DELETE, TRUNCATE ON TABLE school.attendance_logs FROM authenticated;
    END IF;
  END IF;

  IF to_regclass('school.device_logs') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE school.device_logs FROM PUBLIC;
    IF to_regrole('anon') IS NOT NULL THEN
      REVOKE ALL ON TABLE school.device_logs FROM anon;
    END IF;
    IF to_regrole('authenticated') IS NOT NULL THEN
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE school.device_logs FROM authenticated;
    END IF;
  END IF;
END $$;

-- 4. Constrain `school.attendance_logs.status` strictly to canonical enum values
UPDATE school.attendance_logs
   SET status = 'present'
 WHERE status IS NULL
    OR status NOT IN ('present', 'late', 'absent', 'excused');

ALTER TABLE school.attendance_logs
  DROP CONSTRAINT IF EXISTS attendance_logs_valid_status_chk;

ALTER TABLE school.attendance_logs
  ADD CONSTRAINT attendance_logs_valid_status_chk
  CHECK (status IN ('present', 'late', 'absent', 'excused'));

NOTIFY pgrst, 'reload schema';

COMMIT;
