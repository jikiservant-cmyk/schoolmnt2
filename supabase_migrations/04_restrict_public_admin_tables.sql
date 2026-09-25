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
