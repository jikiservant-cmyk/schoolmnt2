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

  if (data.user) {
    const publicAdminClient = createPublicAdminClient();
    const { data: adminProfile, error: profileError } = await publicAdminClient
      .from('admin_profiles')
      .select('role')
      .eq('id', data.user.id)
      .single();
    
    if (profileError || !adminProfile || adminProfile.role !== 'school_admin') {
      await supabase.auth.signOut();
      return { error: 'Access denied. You do not have the required admin role.' };
    }
  }

  redirect('/dashboard');
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
