import { createClient } from '@/utils/supabase/server';
import PeopleDirectoryClient from './PeopleDirectoryClient';

interface SearchProps {
  searchParams: Promise<{ role?: string }>;
}

export default async function PeoplePage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const initialRoleFilter = params.role || 'all';

  const supabase = await createClient();

  // 1. Resolve school ID
  const { data: userData } = await supabase.auth.getUser();
  let schoolId: string | null = null;
  if (userData?.user) {
    const { data: rpcSchoolId } = await supabase.rpc('auth_school_id');
    schoolId = rpcSchoolId || null;
    if (!schoolId) {
       const { data: stf } = await supabase.from('staff_users').select('people(school_id)').eq('auth_user_id', userData.user.id).maybeSingle();
       if (stf?.people && (stf.people as any).school_id) schoolId = (stf.people as any).school_id;
    }
  }

  // 2. Fetch school classes
  const classesQuery = supabase.from('classes').select('id, name').order('name');
  if (schoolId) classesQuery.eq('school_id', schoolId);
  const { data: classesData } = await classesQuery;
  const classes = classesData || [];

  // 3. Fetch Initial Counts (Fast!)
  const [
    { count: totalCount },
    { count: studentsCount },
    { count: teachersCount },
    { count: supportCount },
    { count: adminsCount },
    { count: biometricCount }
  ] = await Promise.all([
    supabase.from('people').select('*', { count: 'exact', head: true }).eq('school_id', schoolId),
    supabase.from('people').select('*', { count: 'exact', head: true }).eq('school_id', schoolId).eq('role', 'student'),
    supabase.from('people').select('*', { count: 'exact', head: true }).eq('school_id', schoolId).eq('role', 'teacher'),
    supabase.from('people').select('*', { count: 'exact', head: true }).eq('school_id', schoolId).eq('role', 'support_staff'),
    supabase.from('people').select('*', { count: 'exact', head: true }).eq('school_id', schoolId).eq('role', 'admin'),
    supabase.from('people').select('*', { count: 'exact', head: true }).eq('school_id', schoolId).not('device_user_id', 'is', null)
  ]);

  const aggregateCounts = {
    total: totalCount || 0,
    students: studentsCount || 0,
    teachers: teachersCount || 0,
    supportStaff: supportCount || 0,
    admins: adminsCount || 0,
    withBiometric: biometricCount || 0
  };

  return (
    <PeopleDirectoryClient 
      classes={classes} 
      initialRoleFilter={initialRoleFilter} 
      initialCounts={aggregateCounts}
    />
  );
}
