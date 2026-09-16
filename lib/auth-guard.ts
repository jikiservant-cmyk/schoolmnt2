import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';

export async function requireSchoolAdmin() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    throw new Error('Unauthorized');
  }

  const publicAdmin = createPublicAdminClient();
  const { data: profile } = await publicAdmin
    .from('admin_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'school_admin') {
    throw new Error('Forbidden: Admin access required');
  }

  const { data: schoolId } = await supabase.rpc('auth_school_id');
  if (!schoolId) {
    throw new Error('No tenant context found');
  }

  return { user, schoolId, supabase };
}
