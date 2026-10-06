'use server';

import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { redirect } from 'next/navigation';
import { consumeRateLimit, resetRateLimit } from '@/lib/security/rate-limit';
import { constantDelay, getClientIp, getFormString, normalizeEmail } from '@/lib/security/request';

// Brute-force / credential-stuffing limits
const PER_ACCOUNT_LIMIT = 5;          // attempts per email+IP
const PER_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const PER_EMAIL_LIMIT = 20;           // attempts per email, any IP (distributed guessing)
const PER_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const PER_IP_LIMIT = 30;              // attempts per IP, any email (credential stuffing)
const PER_IP_WINDOW_MS = 15 * 60 * 1000;

// One generic message for every credential failure so the response never
// reveals whether an account exists, is unconfirmed, or lacks the admin role.
const GENERIC_LOGIN_ERROR = 'Invalid email or password.';

export async function loginAction(formData: FormData) {
  const startedAt = Date.now();

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
  // Fail-CLOSED admin role gate.
  // Previously any exception here (missing service key, network error, DB
  // error) was swallowed by a catch block and the user was redirected to the
  // dashboard anyway — i.e. the role check failed OPEN.
  // ---------------------------------------------------------------------
  let isSchoolAdmin = false;
  try {
    const publicAdminClient = createPublicAdminClient();
    const { data: adminProfile, error: profileErr } = await publicAdminClient
      .from('admin_profiles')
      .select('role, app_type')
      .eq('id', data.user.id)
      .maybeSingle();

    isSchoolAdmin =
      !profileErr &&
      !!adminProfile &&
      adminProfile.role === 'school_admin' &&
      (!adminProfile.app_type || adminProfile.app_type === 'school');
  } catch (profileErr) {
    console.error('[login] admin profile verification failed:', profileErr instanceof Error ? profileErr.message : profileErr);
    isSchoolAdmin = false;
  }

  if (!isSchoolAdmin) {
    // Destroy the session that signInWithPassword just created (cookies were already set).
    try {
      await supabase.auth.signOut();
    } catch {
      /* ignore — cookies are still overwritten below by middleware on next request */
    }
    await constantDelay(startedAt);
    return { error: GENERIC_LOGIN_ERROR };
  }

  // Successful login clears the per-account counter (not the IP/email-wide ones).
  resetRateLimit(`login:acct:${email}:${ip}`);

  redirect('/dashboard');
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
