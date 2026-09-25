-- These public-schema tables are accessed by this app only through a
-- server-side service-role client. Lock direct anon/authenticated PostgREST
-- access unless a reviewed tenant-scoped public policy is added in a future
-- migration. Supabase's service_role bypasses RLS and remains functional.
DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'admin_profiles',
    'profiles',
    'tenants',
    'schools',
    'wallets',
    'transactions',
    'notifications'
  ] LOOP
    IF to_regclass(format('public.%I', target_table)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
    EXECUTE format('DROP POLICY IF EXISTS arena_public_service_role_only ON public.%I', target_table);
    EXECUTE format(
      'CREATE POLICY arena_public_service_role_only ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
      target_table
    );
  END LOOP;
END $$;

-- The app invokes this atomic wallet RPC only with its service-role client.
-- PostgreSQL grants EXECUTE to PUBLIC by default; table RLS alone does not
-- protect a SECURITY DEFINER function from arbitrary wallet-credit requests.
DO $$
DECLARE
  function_identity_arguments TEXT;
BEGIN
  FOR function_identity_arguments IN
    SELECT pg_get_function_identity_arguments(p.oid)
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'credit_wallet'
      AND p.prokind = 'f'
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION public.credit_wallet(%s) FROM PUBLIC, anon, authenticated',
      function_identity_arguments
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.credit_wallet(%s) TO service_role',
      function_identity_arguments
    );
  END LOOP;
END $$;
