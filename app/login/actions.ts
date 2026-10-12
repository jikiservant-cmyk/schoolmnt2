'use server';

import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { hardenAuthCookieOptions } from '@/utils/supabase/cookie-options';
import { redirect } from 'next/navigation';
import { consumeRateLimit, resetRateLimit } from '@/lib/security/rate-limit';
import { constantDelay, getClientIp, getFormString, normalizeEmail, requireSameOrigin } from '@/lib/security/request';

// Brute-force / credential-stuffing limits
const PER_ACCOUNT_LIMIT = 5;          // attempts per email+IP
const PER_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const PER_EMAIL_LIMIT = 20;           // attempts per email, any IP (distributed guessing)
const PER_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const PER_IP_LIMIT = 30;              // attempts per IP, any email (credential stuffing)
const PER_IP_WINDOW_MS = 15 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One generic message for every credential failure so the response never
// reveals whether an account exists, is unconfirmed, lacks the admin role, or
// has an incomplete tenant provisioning record.
const GENERIC_LOGIN_ERROR = 'Invalid email or password.';

function emailIsVerified(user: { email_confirmed_at?: string | null; confirmed_at?: string | null }): boolean {
  return process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'false' || Boolean(user.email_confirmed_at || user.confirmed_at);
}

/**
 * signInWithPassword writes its session cookies before the admin gate runs.
 * Always expire those cookies when the gate rejects the session, even if a
 * network failure prevents Supabase's signOut endpoint from responding.
 */
async function clearAuthCookies() {
  const cookieStore = await cookies();
  for (const cookie of cookieStore.getAll()) {
    if (cookie.name.startsWith('sb-')) {
      cookieStore.set(cookie.name, '', {
        ...hardenAuthCookieOptions({}),
        maxAge: 0,
        expires: new Date(0),
      });
    }
  }
}

export async function loginAction(formData: FormData) {
  const startedAt = Date.now();

  try {
    await requireSameOrigin();
  } catch {
    await constantDelay(startedAt);
    return { error: 'Request could not be accepted.' };
  }

  const email = normalizeEmail(getFormString(formData, 'email', 254));
  // bcrypt (used by GoTrue) only considers the first 72 bytes; cap length to avoid DoS.
  const password = getFormString(formData, 'password', 256);

  if (!email || !password) {
    return { error: 'Please provide a valid email and password.' };
  }

  const ip = await getClientIp();
  const checks = [
    consumeRateLimit(`login:acct:${email}:${ip}`, PER_ACCOUNT_LIMIT, PER_ACCOUNT_WINDOW_MS),
    consumeRateLimit(`login:email:${email}`, PER_EMAIL_LIMIT, PER_EMAIL_WINDOW_MS),
    consumeRateLimit(`login:ip:${ip}`, PER_IP_LIMIT, PER_IP_WINDOW_MS),
  ];
  const blocked = checks.find((c) => !c.allowed);
  if (blocked) {
    const mins = Math.max(1, Math.ceil(blocked.retryAfterSeconds / 60));
    await constantDelay(startedAt);
    return { error: `Too many sign-in attempts. Please try again in ${mins} minute(s).` };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user || !data.session) {
    await constantDelay(startedAt);
    return { error: GENERIC_LOGIN_ERROR };
  }

  // ---------------------------------------------------------------------
  // Fail-CLOSED admin + tenant gate.
  // Identity was verified by GoTrue above; role is read with the service role,
  // never from writable user_metadata. Requiring a tenant here also prevents a
  // partially provisioned profile from leaving a live, unusable session behind.
  // ---------------------------------------------------------------------
  let isSchoolAdmin = false;
  try {
    const publicAdminClient = createPublicAdminClient();
    const { data: adminProfile, error: profileErr } = await publicAdminClient
      .from('admin_profiles')
      .select('role, app_type, school_id')
      .eq('id', data.user.id)
      .maybeSingle();

    const { data: schoolId, error: schoolErr } = await supabase.rpc('auth_school_id');
    const tenantIsValid = !schoolErr && typeof schoolId === 'string' && UUID_RE.test(schoolId);
    const profileMatchesTenant = !adminProfile?.school_id ||
      (tenantIsValid && adminProfile.school_id.toLowerCase() === schoolId.toLowerCase());

    isSchoolAdmin =
      !profileErr &&
      !!adminProfile &&
      adminProfile.role === 'school_admin' &&
      (!adminProfile.app_type || adminProfile.app_type === 'school') &&
      emailIsVerified(data.user) &&
      tenantIsValid &&
      profileMatchesTenant;
  } catch (profileErr) {
    console.error('[login] admin profile / tenant verification failed:', profileErr instanceof Error ? profileErr.message : profileErr);
    isSchoolAdmin = false;
  }

  if (!isSchoolAdmin) {
    // Destroy the session that signInWithPassword just created. Clearing the
    // cookie store explicitly keeps this fail-closed when signOut itself fails.
    try {
      await supabase.auth.signOut();
    } catch {
      /* cookie expiration below is still mandatory */
    }
    await clearAuthCookies();
    await constantDelay(startedAt);
    return { error: GENERIC_LOGIN_ERROR };
  }

  // Successful login clears the per-account counter (not the IP/email-wide ones).
  resetRateLimit(`login:acct:${email}:${ip}`);

  redirect('/dashboard');
}

export async function logoutAction() {
  await requireSameOrigin();
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
