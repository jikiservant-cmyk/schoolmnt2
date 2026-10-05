import { requireSchoolAdminPage } from '@/lib/auth-guard';
import PeopleDirectoryClient from './PeopleDirectoryClient';

interface SearchProps {
  searchParams: Promise<{ role?: string }>;
}

export default async function PeoplePage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const initialRoleFilter = params.role || 'all';

  // MULTI-TENANT: the school comes from the verified admin context. Previously,
  // if it couldn't be resolved, the class query ran WITHOUT a school filter
  // (fail-open) and listed every school's classes.
  const { supabase, schoolId } = await requireSchoolAdminPage();

  // 2. Fetch school classes
  const { data: classesData } = await supabase.from('classes').select('id, name').eq('school_id', schoolId).order('name');
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
