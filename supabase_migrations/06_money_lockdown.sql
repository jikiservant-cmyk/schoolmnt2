-- =============================================================================
-- 06_money_lockdown.sql: mandatory lock on everything that is money or SMS cost
-- =============================================================================
-- Run AFTER 03, 04 and 05. Idempotent (safe to re-run). See SECURITY_AUDIT.md
-- Part 6 for the attacks this closes.
--
-- Why it exists: Supabase gives the `anon` role (the public key shipped to
-- every browser) and `authenticated` (any logged-in user) full table rights on
-- the public schema by default, and EXECUTE on every new function. 04 only
-- locked wallets/transactions behind an OPTIONAL switch, and never touched
-- public.tenants, public.profiles, public.credit_wallet, the SMS queue writes
-- or staff roles. Proven in the lab before this migration:
--   * anyone with the public key could set any school's wallet balance, mint
--     credit through public.credit_wallet, insert / erase ledger rows, and
--     rewrite another school's NaJiki tenant code (their top-ups then go to the
--     attacker's tenant);
--   * a teacher could promote themselves to admin, queue unlimited free-text
--     SMS paid by the school, and flip sent SMS back to "pending" (re-sent and
--     re-charged).
--
-- Who still writes these tables: this app's server (service_role key), the
-- SMS Edge Function (MUST use the service_role key) and NaJiki (Prisma over a
-- direct Postgres connection as the table owner). None of them depend on the
-- anon/authenticated grants removed here.
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'school' AND p.proname = 'auth_school_id' AND p.pronargs = 0) THEN
    RAISE EXCEPTION '06_money_lockdown: school.auth_school_id() not found. Run 04_rls_tenant_isolation.sql first.';
  END IF;
END $$;

-- 1. Money functions: server only ----------------------------------------------
-- Every function in public/school whose name says money or SMS (credit_wallet,
-- apply_payment, anything *wallet*/*balance*/*debit*/*sms*...) loses EXECUTE
-- for PUBLIC/anon/authenticated and keeps it for service_role. Each one is
-- listed in the NOTICE output; review that list.
DO $$
DECLARE f record; has_sr boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'school')
      AND p.prokind = 'f'
      AND p.proname ~* '(wallet|credit|debit|balance|payment|topup|top_up|charge|refund|deduct|ledger|sms)'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')  -- skip extension functions
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f.sig);
    END IF;
    IF has_sr THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig); END IF;
    RAISE NOTICE 'server-only function: %', f.sig;
  END LOOP;
END $$;

-- 2. public.wallets / public.transactions: read own school, never write ----------
DO $$
DECLARE wcond text := NULL; tcond text := NULL;
BEGIN
  IF to_regclass('public.wallets') IS NOT NULL THEN
    SELECT string_agg(format('%I::text = school.auth_school_id()::text', column_name), ' OR ')
      INTO wcond FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'wallets' AND column_name IN ('tenant_id', 'school_id');
    SELECT string_agg(format('w.%I::text = school.auth_school_id()::text', column_name), ' OR ')
      INTO tcond FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'wallets' AND column_name IN ('tenant_id', 'school_id');
    ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS school_wallet_read ON public.wallets;
    IF wcond IS NOT NULL THEN
      EXECUTE 'CREATE POLICY school_wallet_read ON public.wallets FOR SELECT TO authenticated USING (' || wcond || ')';
    END IF;
    REVOKE ALL ON public.wallets FROM anon;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.wallets FROM authenticated;
    GRANT SELECT ON public.wallets TO authenticated;
    RAISE NOTICE 'public.wallets: read-own only, no client writes';
  END IF;

  IF to_regclass('public.transactions') IS NOT NULL THEN
    ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS school_tx_read ON public.transactions;
    IF wcond IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'wallet_id') THEN
      EXECUTE 'CREATE POLICY school_tx_read ON public.transactions FOR SELECT TO authenticated USING ('
           || 'EXISTS (SELECT 1 FROM public.wallets w WHERE w.id = wallet_id AND (' || tcond || ')))';
    END IF;
    REVOKE ALL ON public.transactions FROM anon;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.transactions FROM authenticated;
    GRANT SELECT ON public.transactions TO authenticated;
    RAISE NOTICE 'public.transactions: read-own only, no client writes';
  END IF;
END $$;

-- 3. public.tenants: the NaJiki tenant code decides WHERE a top-up's money goes --
DO $$ BEGIN
  IF to_regclass('public.tenants') IS NOT NULL THEN
    ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS own_tenant_read ON public.tenants;
    CREATE POLICY own_tenant_read ON public.tenants FOR SELECT TO authenticated
      USING (id::text = school.auth_school_id()::text);
    REVOKE ALL ON public.tenants FROM anon;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.tenants FROM authenticated;
    GRANT SELECT ON public.tenants TO authenticated;
    RAISE NOTICE 'public.tenants: read-own only, no client writes';
  END IF;
END $$;

-- 4. public.profiles / public.admin_profiles: no self-assigned school, code or role
DO $$
DECLARE own text; safe_cols text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles', 'admin_profiles'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    SELECT string_agg(format('%I = auth.uid()', column_name), ' OR ') INTO own
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = t AND column_name IN ('id', 'user_id');
    SELECT string_agg(quote_ident(column_name), ', ') INTO safe_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = t
       AND column_name NOT IN ('id', 'user_id', 'school_id', 'tenant_id', 'code', 'tenant_code',
                               'role', 'staff_role', 'is_admin', 'is_super_admin', 'permissions');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS own_profile_read ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS own_profile_update ON public.%I', t);
    IF own IS NOT NULL THEN
      EXECUTE format('CREATE POLICY own_profile_read ON public.%I FOR SELECT TO authenticated USING (%s)', t, own);
      EXECUTE format('CREATE POLICY own_profile_update ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', t, own, own);
    END IF;
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    -- Harmless columns (name, avatar...) stay editable by their owner.
    IF safe_cols IS NOT NULL AND t = 'profiles' THEN
      EXECUTE format('GRANT UPDATE (%s) ON public.%I TO authenticated', safe_cols, t);
    END IF;
    RAISE NOTICE 'public.%: own row only; school/code/role columns server-only', t;
  END LOOP;
END $$;

-- 5. school tables that are money, SMS cost or privilege: server writes only ------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['schools', 'notifications', 'staff_users', 'payment_intents', 'payment_events'] LOOP
    IF to_regclass('school.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON school.%I FROM anon, authenticated', t);
    RAISE NOTICE 'school.%: no client writes (server/service_role only)', t;
  END LOOP;
END $$;

-- 6. One attendance SMS per child, per direction, per local day -----------------
-- The app sets dedupe_key = 'att:<person>:<check_in|check_out>:<YYYY-MM-DD EAT>'
-- on every attendance SMS (kiosk, class register, biometric device). The unique
-- index makes simultaneous taps / submissions / uploads unable to queue (and
-- pay for) a second SMS. Other notifications leave it NULL (never conflicts).
ALTER TABLE school.notifications ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_school_dedupe_uniq
  ON school.notifications (school_id, dedupe_key);

-- 7. Verification (read-only; run by hand after the migration) -------------------
-- Any money function still callable by the public key or a logged-in user:
--   SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname IN ('public','school')
--     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
--     AND p.proname ~* '(wallet|credit|debit|balance|payment|topup|charge|refund|deduct|ledger|sms)';
-- Any write the public key / logged-in users still have on these tables:
--   SELECT table_schema, table_name, grantee, privilege_type FROM information_schema.role_table_grants
--   WHERE grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
--     AND table_name IN ('wallets','transactions','tenants','profiles','admin_profiles','schools',
--                        'notifications','staff_users','payment_intents','payment_events');
--
-- ROLLBACK for one function, ONLY if a trusted caller really needs it (prefer
-- giving that caller the service_role key instead):
--   GRANT EXECUTE ON FUNCTION public.<name>(<args>) TO authenticated;
