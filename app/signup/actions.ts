'use server';

import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function signupAction(formData: FormData) {
  const supabase = await createClient();
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const fullName = formData.get('fullName') as string;

  if (!email || !password || !fullName) {
    return { error: 'Please fill in all fields.' };
  }

  const { data: authData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        app_type: 'school',
        role: 'school_admin'
      },
    },
  });

  if (signUpError) {
    return { error: signUpError.message };
  }

  if (authData.user) {
    try {
      const publicAdminClient = createPublicAdminClient();

      // Create or update a row in public.admin_profiles for that same user id
      const { error: adminProfileError } = await publicAdminClient
        .from('admin_profiles')
        .upsert({
          id: authData.user.id,
          app_type: 'school',
          role: 'school_admin',
          full_name: fullName,
          email: email
        });

      if (adminProfileError) {
        console.error('Failed to create admin profile:', adminProfileError);
        return { error: `Failed to create admin profile: ${adminProfileError.message}` };
      }

      // Call the onboarding RPC function to provision tenant, school, people, and staff records
      const { error: rpcError } = await publicAdminClient
        .rpc('rp_create_school_from_admin_profile', {
          p_admin_profile_id: authData.user.id
        });

      if (rpcError) {
        console.error('Failed to execute onboarding RPC:', rpcError);
        return { error: `Onboarding process failed: ${rpcError.message}` };
      }

    } catch (error: any) {
      console.error('Provisioning exception:', error);
      return { error: error?.message || 'An error occurred while provisioning your school. Please try again.' };
    }
  }

  revalidatePath('/', 'layout');
  redirect('/dashboard');
}
