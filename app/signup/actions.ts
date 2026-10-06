'use server';

import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { consumeRateLimit } from '@/lib/security/rate-limit';
import { constantDelay, getClientIp, getFormString, normalizeEmail } from '@/lib/security/request';

const SIGNUP_IP_LIMIT = 5;
const SIGNUP_IP_WINDOW_MS = 60 * 60 * 1000;

// Neutral response used whenever we must not reveal whether an email is already registered.
const NEUTRAL_SIGNUP_MESSAGE =
  'If this email can be registered, your account has been created. Check your inbox to confirm it, then sign in.';

function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters long.';
  // bcrypt silently truncates beyond 72 bytes — reject instead of giving a false sense of security.
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be at most 72 bytes long.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number.';
  }
  return null;
}

export async function signupAction(formData: FormData) {
  const startedAt = Date.now();

  const email = normalizeEmail(getFormString(formData, 'email', 254));
  const password = getFormString(formData, 'password', 256);
  const rawName = getFormString(formData, 'fullName', 200);
  // Strip control characters; React escapes on render but names also flow into SMS / device commands.
  const fullName = rawName?.replace(/[\u0000-\u001F\u007F]/g, '').trim() || '';

  if (!email || !password || !fullName) {
    return { error: 'Please fill in all fields with valid values.' };
  }
  if (fullName.length < 2 || fullName.length > 120) {
    return { error: 'Full name must be between 2 and 120 characters.' };
  }
  const pwError = validatePassword(password);
  if (pwError) return { error: pwError };

  const ip = await getClientIp();
  const rl = consumeRateLimit(`signup:ip:${ip}`, SIGNUP_IP_LIMIT, SIGNUP_IP_WINDOW_MS);
  if (!rl.allowed) {
    return { error: 'Too many registration attempts. Please try again later.' };
  }

  const supabase = await createClient();
  const { data: authData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // NOTE: user_metadata is user-controlled (editable via auth.updateUser).
      // It is informational only — authorization is enforced from
      // public.admin_profiles. Do NOT read `role` from user_metadata in RLS.
      data: {
        full_name: fullName,
        app_type: 'school',
      },
    },
  });

  if (signUpError) {
    const code = (signUpError as { code?: string }).code;
    if (code === 'user_already_exists' || /already registered/i.test(signUpError.message)) {
      await constantDelay(startedAt);
      return { info: NEUTRAL_SIGNUP_MESSAGE };
    }
    if (code === 'weak_password') {
      return { error: 'Password is too weak. Please choose a stronger password.' };
    }
    console.error('[signup] signUp failed:', signUpError.message);
    return { error: 'Unable to create account. Please try again later.' };
  }

  const user = authData.user;

  // When email confirmation is enabled GoTrue returns an obfuscated user with
  // an EMPTY identities array for emails that already exist. Previously the
  // code would still upsert admin_profiles with that id and re-run tenant
  // provisioning — never provision unless this is a genuinely new identity.
  const isNewUser = !!user && Array.isArray(user.identities) && user.identities.length > 0;
  if (!user || !isNewUser) {
    await constantDelay(startedAt);
    return { info: NEUTRAL_SIGNUP_MESSAGE };
  }

  try {
    const publicAdminClient = createPublicAdminClient();

    // Refuse to overwrite an existing profile (e.g. a profile owned by another app_type).
    const { data: existingProfile, error: existingErr } = await publicAdminClient
      .from('admin_profiles')
      .select('id, role, app_type')
      .eq('id', user.id)
      .maybeSingle();

    if (existingErr) {
      console.error('[signup] profile lookup failed:', existingErr.message);
      return { error: 'Unable to complete registration. Please contact support.' };
    }
    if (existingProfile && existingProfile.app_type && existingProfile.app_type !== 'school') {
      return { error: 'Unable to complete registration. Please contact support.' };
    }

    const { error: adminProfileError } = await publicAdminClient
      .from('admin_profiles')
      .upsert({
        id: user.id,
        app_type: 'school',
        role: 'school_admin',
        full_name: fullName,
        email,
      });

    if (adminProfileError) {
      console.error('[signup] failed to create admin profile:', adminProfileError.message);
      return { error: 'Unable to complete registration. Please contact support.' };
    }

    const { error: rpcError } = await publicAdminClient.rpc('rp_create_school_from_admin_profile', {
      p_admin_profile_id: user.id,
    });

    if (rpcError) {
      console.error('[signup] onboarding RPC failed:', rpcError.message);
      return { error: 'School provisioning failed. Please contact support.' };
    }
  } catch (error) {
    console.error('[signup] provisioning exception:', error instanceof Error ? error.message : error);
    return { error: 'An error occurred while provisioning your school. Please try again.' };
  }

  // No session => email confirmation is required before first login.
  if (!authData.session) {
    return { info: NEUTRAL_SIGNUP_MESSAGE };
  }

  revalidatePath('/', 'layout');
  redirect('/dashboard');
}
