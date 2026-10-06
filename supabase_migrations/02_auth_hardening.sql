-- =====================================================================
-- AUTH HARDENING (security audit 2026-10)
-- Execute in the Supabase SQL editor. Idempotent.
-- =====================================================================

-- 1. Teacher PIN lockout columns.
--    verifyTeacherPin and resetTeacherPinAction now both use
--    failed_attempts / locked_until (previously the reset wrote
--    pin_failed_attempts / pin_locked_until, so resets never cleared a lockout).
ALTER TABLE school.staff_users ADD COLUMN IF NOT EXISTS failed_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE school.staff_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- 2. admin_profiles must never be writable by end users. Roles are granted only
--    by the server (service role) during signup. Verify that no RLS policy lets
--    `authenticated` INSERT/UPDATE this table, otherwise a user could grant
--    themselves role = 'school_admin'.
--    Uncomment after confirming no other app in this Supabase project writes
--    admin_profiles from the browser:
-- ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
-- REVOKE INSERT, UPDATE, DELETE ON public.admin_profiles FROM anon, authenticated;

-- 3. REVIEW MANUALLY: make sure no RLS policy or SQL function (including
--    school.auth_school_id()) trusts auth.jwt() -> 'user_metadata' or
--    raw_user_meta_data for authorization. user_metadata is editable by the
--    user via supabase.auth.updateUser(). Use app_metadata or admin_profiles.
