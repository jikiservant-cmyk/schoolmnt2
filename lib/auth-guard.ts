import { cache } from 'react';
import { redirect, unstable_rethrow } from 'next/navigation';
import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { requireSameOrigin } from '@/lib/security/request';
import type { User } from '@supabase/supabase-js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

type AdminCheck =
  | { ok: true; user: User; schoolId: string; supabase: ServerSupabase }
  | { ok: false; reason: 'unauthenticated' | 'forbidden' | 'unverified_email' | 'no_tenant' | 'error' };

/**
 * Email confirmation is an authorization prerequisite by default. Supabase's
 * confirmation setting must not be the only thing preventing an unverified
 * signup from becoming an administrator. Set AUTH_REQUIRE_EMAIL_VERIFICATION=
 * false only for a deliberate, separately verified SSO / invitation flow.
 */
function hasVerifiedEmail(user: User): boolean {
  if (process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'false') return true;
  return Boolean(user.email_confirmed_at || user.confirmed_at);
}

/**
 * Single source of truth for "is this request a school admin?".
 *
 * - Identity comes from `auth.getUser()` (validated against GoTrue, NOT the
 *   unverified cookie JWT like `getSession()`).
 * - Role comes from `public.admin_profiles` read with the service-role key.
 *   NEVER from `user_metadata` — that is writable by the user themselves via
 *   `supabase.auth.updateUser({ data: { role: 'school_admin' } })`.
 * - A profile that is explicitly tied to another school is rejected rather
 *   than allowing a corrupted staff membership to switch tenants.
 * - Every failure path is fail-CLOSED.
 */
export const checkSchoolAdmin = cache(async function checkSchoolAdmin(): Promise<AdminCheck> {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return { ok: false, reason: 'unauthenticated' };
    if (!hasVerifiedEmail(user)) return { ok: false, reason: 'unverified_email' };

    const publicAdmin = createPublicAdminClient();
    const { data: profile, error: profileErr } = await publicAdmin
      .from('admin_profiles')
      .select('role, app_type, school_id')
      .eq('id', user.id)
      .maybeSingle();

    if (profileErr || !profile) return { ok: false, reason: 'forbidden' };
    if (profile.role !== 'school_admin') return { ok: false, reason: 'forbidden' };
    if (profile.app_type && profile.app_type !== 'school') return { ok: false, reason: 'forbidden' };

    const { data: schoolId, error: rpcErr } = await supabase.rpc('auth_school_id');
    if (rpcErr || !schoolId || typeof schoolId !== 'string' || !UUID_RE.test(schoolId)) return { ok: false, reason: 'no_tenant' };

    // Older profiles may not have school_id yet, so permit NULL during the
    // migration. A non-NULL mismatch is always an authorization failure.
    if (profile.school_id && profile.school_id.toLowerCase() !== schoolId.toLowerCase()) {
      return { ok: false, reason: 'forbidden' };
    }

    return { ok: true, user, schoolId, supabase };
  } catch (err) {
    // Let Next.js's own control-flow signals (dynamic-rendering bail-out,
    // redirect, notFound) through; swallowing them could let Next cache a
    // page statically. Real failures still fail closed below.
    unstable_rethrow(err);
    console.error('[auth-guard] admin verification failed:', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'error' };
  }
});

/** For server actions / route handlers: throws on failure. */
export async function requireSchoolAdmin() {
  // Server Actions normally perform this check themselves. Keep an explicit
  // defense-in-depth check because some deployments intentionally use
  // SameSite=None cookies for embedded previews.
  await requireSameOrigin();

  const result = await checkSchoolAdmin();
  if (!result.ok) {
    switch (result.reason) {
      case 'unauthenticated':
        throw new Error('Unauthorized');
      case 'unverified_email':
        throw new Error('Email verification required');
      case 'forbidden':
        throw new Error('Forbidden: Admin access required');
      case 'no_tenant':
        throw new Error('No tenant context found');
      default:
        throw new Error('Authorization check failed');
    }
  }
  const { user, schoolId, supabase } = result;
  return { user, schoolId, supabase };
}

/**
 * For server components / layouts: redirects instead of throwing. A valid
 * Supabase session that is NOT a verified school admin (e.g. a user who signed
 * up directly against the public GoTrue endpoint with the anon key, whose
 * email is unverified, or whose admin role was revoked) is signed out and
 * bounced to /login.
 */
export async function requireSchoolAdminPage() {
  const result = await checkSchoolAdmin();
  if (!result.ok) {
    if (result.reason !== 'unauthenticated') {
      try {
        const supabase = await createClient();
        await supabase.auth.signOut();
      } catch (err) {
        unstable_rethrow(err);
        /* cookies are read-only in server components; middleware will refresh */
      }
    }
    redirect(result.reason === 'unauthenticated' ? '/login' : '/login?error=access_denied');
  }
  return { user: result.user, schoolId: result.schoolId, supabase: result.supabase };
}
