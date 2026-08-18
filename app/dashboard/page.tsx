import { createClient } from '@/utils/supabase/server';
import DashboardClient from './DashboardClient';

export default async function DashboardPage() {
  const supabase = await createClient();

  let studentCount = 0;
  let teacherCount = 0;
  let classCount = 0;
  let devicesList: any[] = [];
  let recentLogs: any[] = [];
  let recentMessages: any[] = [];
  let adminName = 'Derrick';

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: staffData } = await supabase
        .from('staff_users')
        .select('people(full_name)')
        .eq('auth_user_id', user.id)
        .maybeSingle();

      if (staffData && staffData.people) {
        const p = staffData.people as any;
        adminName = p.full_name?.split(' ')[0] || 'Derrick';
      } else {
        adminName = user.user_metadata?.full_name?.split(' ')[0] || 'Derrick';
      }
    }

    const [
      { count: students },
      { count: teachers },
      { count: classes },
      { data: devicesData },
      { data: logsData },
      { data: messagesData }
    ] = await Promise.all([
      supabase.from('people').select('*', { count: 'exact', head: true }).eq('role', 'student'),
      supabase.from('people').select('*', { count: 'exact', head: true }).in('role', ['teacher', 'admin', 'support_staff']),
      supabase.from('classes').select('*', { count: 'exact', head: true }),
      supabase.from('devices').select('*').limit(5),
      supabase
        .from('attendance_logs')
        .select(`
          id,
          status,
          attendance_type,
          occurred_at,
          source,
          people (
            full_name,
            role,
            phone
          ),
          classes:classes(
            name
          )
        `)
        .order('occurred_at', { ascending: false })
        .limit(30),
      supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10)
    ]);

    studentCount = students || 0;
    teacherCount = teachers || 0;
    classCount = classes || 0;
    devicesList = devicesData || [];
    recentLogs = logsData || [];
    recentMessages = messagesData || [];
  } catch (err) {
    console.error('Error loading dashboard page data:', err);
    studentCount = 0;
    teacherCount = 0;
  }

  // Student metrics
  const studentLogs = recentLogs.filter(l => (l.people?.role || 'student') === 'student');
  const presentCount = studentLogs.filter(l => l.status === 'present').length;
  const lateCount = studentLogs.filter(l => l.status === 'late').length;
  const absentCount = Math.max(0, studentCount - (presentCount + lateCount));

  const presentPct = studentCount > 0 ? Number(((presentCount / studentCount) * 100).toFixed(1)) : 0;
  const latePct = studentCount > 0 ? Number(((lateCount / studentCount) * 100).toFixed(1)) : 0;
  const absentPct = studentCount > 0 ? Number(((absentCount / studentCount) * 100).toFixed(1)) : 0;

  // Teacher metrics
  const teacherLogs = recentLogs.filter(l => l.people?.role === 'teacher' || l.people?.role === 'admin' || l.people?.role === 'support_staff');
  const teacherPresentCount = teacherLogs.filter(l => l.status === 'present').length;
  const teacherLateCount = teacherLogs.filter(l => l.status === 'late').length;
  const teacherAbsentCount = Math.max(0, teacherCount - (teacherPresentCount + teacherLateCount));

  const teacherPresentPct = teacherCount > 0 ? Number(((teacherPresentCount / teacherCount) * 100).toFixed(1)) : 0;
  const teacherLatePct = teacherCount > 0 ? Number(((teacherLateCount / teacherCount) * 100).toFixed(1)) : 0;
  const teacherAbsentPct = teacherCount > 0 ? Number(((teacherAbsentCount / teacherCount) * 100).toFixed(1)) : 0;

  // Dynamic greeting
  const hour = new Date().getHours();
  let greeting = 'Good afternoon';
  if (hour < 12) greeting = 'Good morning';
  else if (hour >= 17) greeting = 'Good evening';

  // Format date in uppercase Apple style e.g. SUNDAY · 16 AUGUST 2026
  const formattedDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).toUpperCase().replace(',', ' ·');

  return (
    <DashboardClient 
      initialLogs={recentLogs}
      studentCount={studentCount}
      presentCount={presentCount}
      lateCount={lateCount}
      absentCount={absentCount}
      presentPct={presentPct}
      latePct={latePct}
      absentPct={absentPct}
      teacherCount={teacherCount}
      teacherPresentCount={teacherPresentCount}
      teacherLateCount={teacherLateCount}
      teacherAbsentCount={teacherAbsentCount}
      teacherPresentPct={teacherPresentPct}
      teacherLatePct={teacherLatePct}
      teacherAbsentPct={teacherAbsentPct}
      devicesList={devicesList}
      recentMessages={recentMessages}
      greeting={greeting}
      adminName={adminName}
      formattedDate={formattedDate}
    />
  );
}
