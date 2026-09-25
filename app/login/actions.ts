'use server';

import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { redirect } from 'next/navigation';

export async function loginAction(formData: FormData) {
  const supabase = await createClient();
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;

  if (!email || !password) {
    return { error: 'Please provide both email and password.' };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { error: error.message };
  }

  if (!data.user) {
    return { error: 'Sign-in succeeded without a user session. Please try again.' };
  }

  try {
    const publicAdminClient = createPublicAdminClient();
    const { data: adminProfile, error: profileError } = await publicAdminClient
      .from('admin_profiles')
      .select('role')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profileError || !adminProfile || adminProfile.role !== 'school_admin') {
      await supabase.auth.signOut();
      return { error: 'Access denied. You do not have the required admin role.' };
    }

    const { data: schoolId, error: tenantError } = await supabase.rpc('auth_school_id');
    if (tenantError || !schoolId) {
      await supabase.auth.signOut();
      return { error: 'No school tenant is linked to this account. Contact your administrator.' };
    }
  } catch (profileErr) {
    console.error('Admin profile verification failed:', profileErr);
    await supabase.auth.signOut();
    return { error: 'Could not verify your school administrator access. Please try again later.' };
  }

  redirect('/dashboard');
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

