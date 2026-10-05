-- =============================================================================
-- 04_rls_tenant_isolation.sql
--
-- WHY: the browser has the public anon key, and any logged-in admin can copy
-- their own session token. With those two, anyone can call Supabase's REST API
-- directly and skip the app's checks. Signup is open, so "any logged-in
-- admin" means "anyone". Row Level Security is the ONLY thing that keeps one
-- school out of another's data on that path.
--
-- WHAT THIS DOES (idempotent, safe to re-run):
--  1. Makes sure school.auth_school_id() exists (creates a safe default if not)
--     and warns if it trusts user-editable JWT metadata.
--  2. For every tenant table in the `school` schema:
--       - enables RLS
--       - adds a PERMISSIVE policy: rows of your own school only
--       - adds a RESTRICTIVE policy with the same rule. Restrictive policies
--         are AND-ed with every other policy, so an old `USING (true)`
--         policy can no longer leak other schools' rows.
--       - revokes all access from `anon` (no unauthenticated route uses it;
--         device and webhook routes use the service role).
--  3. Hides secrets from the logged-in role: teacher PIN hashes, device secrets.
--  4. Makes school.schools read-only for users (the SMS balance is stored in
--     settings, so an admin could otherwise top up their own balance for free).
--  5. OPTIONAL public-schema hardening (wallets, transactions, admin_profiles).
--     Off by default because the public schema may be shared with other apps.
--     See section 5.
--
-- The service role (used by the server) bypasses RLS, so server code is unaffected.
-- =============================================================================

-- 1. Tenant resolver -----------------------------------------------------------
DO $$
DECLARE src text;
BEGIN
  SELECT p.prosrc INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'school' AND p.proname = 'auth_school_id' AND p.pronargs = 0
  LIMIT 1;

  IF src IS NULL THEN
    EXECUTE $f$
      CREATE FUNCTION school.auth_school_id() RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, school, public
      AS 'SELECT su.school_id FROM school.staff_users su WHERE su.auth_user_id = auth.uid() LIMIT 1'
    $f$;
    RAISE NOTICE 'created default school.auth_school_id() (staff_users.auth_user_id -> school_id)';
  ELSIF src ILIKE '%user_metadata%' OR src ILIKE '%raw_user_meta_data%' THEN
    RAISE WARNING 'school.auth_school_id() reads user_metadata, which users can edit themselves (supabase.auth.updateUser). Rewrite it to use a server-controlled table before relying on RLS.';
  END IF;
END $$;

REVOKE ALL ON FUNCTION school.auth_school_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION school.auth_school_id() TO authenticated, service_role;

-- 2. Tenant tables with a school_id column --------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['people','classes','academic_years','devices','device_commands','device_logs',
                           'attendance_logs','parents','person_credentials','notifications','staff_users']
  LOOP
    IF to_regclass('school.' || t) IS NULL OR NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'school' AND table_name = t AND column_name = 'school_id') THEN
      RAISE NOTICE 'skipped school.% (missing table or school_id column)', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE school.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON school.%I', 'tenant_access', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON school.%I', 'tenant_guard', t);
    EXECUTE format('CREATE POLICY tenant_access ON school.%I AS PERMISSIVE FOR ALL TO authenticated '
                   'USING (school_id = school.auth_school_id()) WITH CHECK (school_id = school.auth_school_id())', t);
    EXECUTE format('CREATE POLICY tenant_guard ON school.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING (school_id = school.auth_school_id()) WITH CHECK (school_id = school.auth_school_id())', t);
    EXECUTE format('REVOKE ALL ON school.%I FROM anon', t);
    RAISE NOTICE 'RLS tenant isolation on school.%', t;
  END LOOP;
END $$;

-- 2b. student_parents (no school_id column: scope through the student) ---------
DO $$
BEGIN
  IF to_regclass('school.student_parents') IS NOT NULL THEN
    ALTER TABLE school.student_parents ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_access ON school.student_parents;
    DROP POLICY IF EXISTS tenant_guard ON school.student_parents;
    CREATE POLICY tenant_access ON school.student_parents AS PERMISSIVE FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM school.people p WHERE p.id = student_id AND p.school_id = school.auth_school_id()))
      WITH CHECK (EXISTS (SELECT 1 FROM school.people p WHERE p.id = student_id AND p.school_id = school.auth_school_id()));
    CREATE POLICY tenant_guard ON school.student_parents AS RESTRICTIVE FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM school.people p WHERE p.id = student_id AND p.school_id = school.auth_school_id()))
      WITH CHECK (EXISTS (SELECT 1 FROM school.people p WHERE p.id = student_id AND p.school_id = school.auth_school_id()));
    REVOKE ALL ON school.student_parents FROM anon;
  END IF;
END $$;

-- 2c. schools: users may READ their own school row only, never write it ---------
DO $$
BEGIN
  IF to_regclass('school.schools') IS NOT NULL THEN
    ALTER TABLE school.schools ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_access ON school.schools;
    DROP POLICY IF EXISTS tenant_guard ON school.schools;
    CREATE POLICY tenant_access ON school.schools AS PERMISSIVE FOR SELECT TO authenticated
      USING (id = school.auth_school_id());
    CREATE POLICY tenant_guard ON school.schools AS RESTRICTIVE FOR ALL TO authenticated
      USING (id = school.auth_school_id()) WITH CHECK (id = school.auth_school_id());
    REVOKE ALL ON school.schools FROM anon;
    -- settings.balance is the prepaid SMS credit; only the server may change it.
    REVOKE INSERT, UPDATE, DELETE ON school.schools FROM authenticated;
  END IF;
END $$;

-- 3. Secret columns: hidden from the logged-in role ------------------------------
-- An admin could otherwise download teacher PIN bcrypt hashes (6-char PINs are
-- crackable offline) and device secret hashes. The app reads these only with
-- the service role.
DO $$
DECLARE spec record; cols text;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
      ('staff_users', ARRAY['pin_hash','failed_attempts','locked_until']),
      ('devices',     ARRAY['device_secret','device_secret_hash'])) AS v(tbl, secret)
  LOOP
    IF to_regclass('school.' || spec.tbl) IS NULL THEN CONTINUE; END IF;
    SELECT string_agg(quote_ident(column_name), ', ') INTO cols
    FROM information_schema.columns
    WHERE table_schema = 'school' AND table_name = spec.tbl AND column_name <> ALL (spec.secret);
    EXECUTE format('REVOKE SELECT ON school.%I FROM authenticated', spec.tbl);
    EXECUTE format('GRANT SELECT (%s) ON school.%I TO authenticated', cols, spec.tbl);
    -- Writes to the secret columns are server-only as well.
    EXECUTE format('REVOKE INSERT, UPDATE ON school.%I FROM authenticated', spec.tbl);
    EXECUTE format('GRANT INSERT (%s), UPDATE (%s) ON school.%I TO authenticated', cols, cols, spec.tbl);
    RAISE NOTICE 'secret columns hidden on school.%: %', spec.tbl, spec.secret;
  END LOOP;
END $$;

-- 5. OPTIONAL: public schema (money + roles) -------------------------------------
-- Turn on by running this first in the same session:
--     SET smartskoolz.harden_public = 'on';
-- Leave it off if other apps in this Supabase project write these tables from
-- the browser. Effect: users can READ only their own school's wallet,
-- transactions and their own admin profile, and can never WRITE them (the
-- server uses the service role).
DO $$
BEGIN
  IF coalesce(current_setting('smartskoolz.harden_public', true), '') <> 'on' THEN
    RAISE NOTICE 'public schema hardening skipped (SET smartskoolz.harden_public = ''on'' to apply)';
    RETURN;
  END IF;

  IF to_regclass('public.wallets') IS NOT NULL THEN
    ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS school_wallet_read ON public.wallets;
    CREATE POLICY school_wallet_read ON public.wallets FOR SELECT TO authenticated
      USING (tenant_id = school.auth_school_id());
    REVOKE INSERT, UPDATE, DELETE ON public.wallets FROM anon, authenticated;
    REVOKE SELECT ON public.wallets FROM anon;
  END IF;

  IF to_regclass('public.transactions') IS NOT NULL THEN
    ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS school_tx_read ON public.transactions;
    CREATE POLICY school_tx_read ON public.transactions FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.wallets w WHERE w.id = wallet_id AND w.tenant_id = school.auth_school_id()));
    REVOKE INSERT, UPDATE, DELETE ON public.transactions FROM anon, authenticated;
    REVOKE SELECT ON public.transactions FROM anon;
  END IF;

  IF to_regclass('public.admin_profiles') IS NOT NULL THEN
    ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS own_profile_read ON public.admin_profiles;
    CREATE POLICY own_profile_read ON public.admin_profiles FOR SELECT TO authenticated
      USING (id = auth.uid());
    -- Users must never grant themselves school_admin.
    REVOKE INSERT, UPDATE, DELETE ON public.admin_profiles FROM anon, authenticated;
    REVOKE SELECT ON public.admin_profiles FROM anon;
  END IF;
  RAISE NOTICE 'public schema hardening applied';
END $$;

-- 6. AUDIT (read-only) ------------------------------------------------------------
-- Tables still WITHOUT RLS in school/public. Each of these is readable by any
-- logged-in user through the REST API, so review every row:
--   SELECT n.nspname, c.relname
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE c.relkind = 'r' AND n.nspname IN ('school','public') AND NOT c.relrowsecurity;
--
-- Wide-open policies (USING true) that would leak rows where no restrictive
-- guard exists:
--   SELECT schemaname, tablename, policyname, permissive, roles, qual
--   FROM pg_policies WHERE schemaname IN ('school','public') AND (qual IS NULL OR qual = 'true');
--
-- Current tenant resolver (make sure it does NOT read user_metadata):
--   SELECT pg_get_functiondef('school.auth_school_id()'::regprocedure);
