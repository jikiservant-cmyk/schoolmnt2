import { createClient } from '@/utils/supabase/server';
import DashboardClient from './DashboardClient';
import { getEATDayRange, getEATDateKey, formatEATDate } from '@/lib/eat-time';

export default async function DashboardPage() {
  const supabase = await createClient();

  let studentCount = 0;
  let teacherCount = 0;
  let classCount = 0;
  let devicesList: any[] = [];
  let todayLogs: any[] = [];
  let classBreakdown: any[] = [];
  let weekTrend: any[] = [];
  let recentMessages: any[] = [];
  let adminName = 'Derrick';

  // 1. Get current date range in East Africa Time (EAT, UTC+3)
  const now = new Date();
  const todayRange = getEATDayRange(now);
  const todayKey = todayRange.dateStr;

  // 2. Calculate the 7 days of the current week (Monday through Sunday in EAT)
  // Determine current day of week: 0 is Sun, 1 is Mon, ..., 6 is Sat
  const dayOfWeek = now.getDay();
  // Monday offset: if Sunday (0), it's 6 days behind; otherwise dayOfWeek - 1
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  
  const mondayDate = new Date(now);
  mondayDate.setDate(now.getDate() - daysSinceMonday);
  mondayDate.setHours(0, 0, 0, 0);

  const weekDaysData: { dayName: string; dateKey: string; dateLabel: string; startIso: string; endIso: string; isToday: boolean; isFuture: boolean }[] = [];
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayDate);
    d.setDate(mondayDate.getDate() + i);
    const dayRange = getEATDayRange(d);
    const isToday = dayRange.dateStr === todayKey;
    const isFuture = dayRange.dateStr > todayKey;

    weekDaysData.push({
      dayName: dayNames[i],
      dateKey: dayRange.dateStr,
      dateLabel: formatEATDate(d, { month: 'short', day: 'numeric' }),
      startIso: dayRange.startIso,
      endIso: dayRange.endIso,
      isToday,
      isFuture,
    });
  }

  const weekStartIso = weekDaysData[0].startIso;
  const weekEndIso = weekDaysData[6].endIso;

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

    // Fetch counts and daily logs
    const [
      { count: students },
      { count: teachers },
      { data: classesData },
      { data: studentsList },
      { data: devicesData },
      { data: todayLogsData },
      { data: weekLogsData },
      { data: messagesData }
    ] = await Promise.all([
      supabase.from('people').select('*', { count: 'exact', head: true }).eq('role', 'student'),
      supabase.from('people').select('*', { count: 'exact', head: true }).in('role', ['teacher', 'admin', 'support_staff']),
      supabase.from('classes').select('id, name').order('name'),
      supabase.from('people').select('id, full_name, role, class_id').eq('role', 'student'),
      supabase.from('devices').select('*').limit(5),
      // STRICTLY TODAY's attendance logs in EAT
      supabase
        .from('attendance_logs')
        .select(`
          id,
          person_id,
          status,
          attendance_type,
          occurred_at,
          source,
          people:people (
            id,
            full_name,
            role,
            phone,
            class_id,
            classes:class_id (
              name
            )
          ),
          classes:classes(
            name
          )
        `)
        .gte('occurred_at', todayRange.startIso)
        .lte('occurred_at', todayRange.endIso)
        .order('occurred_at', { ascending: false }),
      // Week's attendance logs for trend calculation
      supabase
        .from('attendance_logs')
        .select('id, person_id, status, occurred_at, people:people(role)')
        .gte('occurred_at', weekStartIso)
        .lte('occurred_at', weekEndIso),
      supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10)
    ]);

    studentCount = students || 0;
    teacherCount = teachers || 0;
    classCount = classesData?.length || 0;
    devicesList = devicesData || [];
    todayLogs = todayLogsData || [];
    recentMessages = messagesData || [];

    // Calculate unique student & teacher attendance for TODAY
    const studentLogsMap = new Map<string, any>();
    const teacherLogsMap = new Map<string, any>();

    todayLogs.forEach(log => {
      const personId = log.person_id || log.people?.id;
      const role = log.people?.role || 'student';
      if (personId) {
        if (role === 'student') {
          if (!studentLogsMap.has(personId) || log.status === 'present') {
            studentLogsMap.set(personId, log);
          }
        } else {
          if (!teacherLogsMap.has(personId) || log.status === 'present') {
            teacherLogsMap.set(personId, log);
          }
        }
      }
    });

    // Class by class breakdown for TODAY
    if (classesData && classesData.length > 0 && studentsList) {
      const studentsByClass = new Map<string, string[]>();
      studentsList.forEach((st: any) => {
        if (st.class_id) {
          const list = studentsByClass.get(st.class_id) || [];
          list.push(st.id);
          studentsByClass.set(st.class_id, list);
        }
      });

      classBreakdown = classesData.map((cls: any) => {
        const enrolledIds = studentsByClass.get(cls.id) || [];
        const enrolled = enrolledIds.length;
        let presentToday = 0;
        let lateToday = 0;

        enrolledIds.forEach(id => {
          const stLog = studentLogsMap.get(id);
          if (stLog) {
            if (stLog.status === 'present') presentToday++;
            else if (stLog.status === 'late') lateToday++;
            else presentToday++;
          }
        });

        const rate = enrolled > 0 ? Math.round(((presentToday + lateToday) / enrolled) * 100) : 0;

        return {
          id: cls.id,
          name: cls.name,
          enrolled,
          presentToday,
          lateToday,
          absentToday: Math.max(0, enrolled - (presentToday + lateToday)),
          rate,
        };
      });
    }

    // Calculate 7-Day Week Trend from weekLogsData
    const logsByDateKey = new Map<string, Set<string>>();
    (weekLogsData || []).forEach((l: any) => {
      if ((l.people?.role || 'student') === 'student' && l.person_id) {
        const key = getEATDateKey(l.occurred_at);
        const set = logsByDateKey.get(key) || new Set<string>();
        set.add(l.person_id);
        logsByDateKey.set(key, set);
      }
    });

    weekTrend = weekDaysData.map(wd => {
      const attendedSet = logsByDateKey.get(wd.dateKey);
      const attendedCount = attendedSet ? attendedSet.size : 0;
      const rate = studentCount > 0 ? Math.min(100, Math.round((attendedCount / studentCount) * 100)) : 0;

      return {
        dayName: wd.dayName,
        dateKey: wd.dateKey,
        dateLabel: wd.dateLabel,
        isToday: wd.isToday,
        isFuture: wd.isFuture,
        attendedCount,
        rate: wd.isFuture ? null : rate,
      };
    });

  } catch (err) {
    console.error('Error loading daily dashboard page data:', err);
    studentCount = 0;
    teacherCount = 0;
  }

  // Student metrics for TODAY
  let presentCount = 0;
  let lateCount = 0;

  todayLogs.forEach(l => {
    const role = l.people?.role || 'student';
    if (role === 'student') {
      if (l.status === 'present') presentCount++;
      else if (l.status === 'late') lateCount++;
    }
  });

  const absentCount = Math.max(0, studentCount - (presentCount + lateCount));
  const presentPct = studentCount > 0 ? Number(((presentCount / studentCount) * 100).toFixed(1)) : 0;
  const latePct = studentCount > 0 ? Number(((lateCount / studentCount) * 100).toFixed(1)) : 0;
  const absentPct = studentCount > 0 ? Number(((absentCount / studentCount) * 100).toFixed(1)) : 0;

  // Teacher metrics for TODAY
  let teacherPresentCount = 0;
  let teacherLateCount = 0;

  todayLogs.forEach(l => {
    const role = l.people?.role;
    if (role === 'teacher' || role === 'admin' || role === 'support_staff') {
      if (l.status === 'present') teacherPresentCount++;
      else if (l.status === 'late') teacherLateCount++;
    }
  });

  const teacherAbsentCount = Math.max(0, teacherCount - (teacherPresentCount + teacherLateCount));
  const teacherPresentPct = teacherCount > 0 ? Number(((teacherPresentCount / teacherCount) * 100).toFixed(1)) : 0;
  const teacherLatePct = teacherCount > 0 ? Number(((teacherLateCount / teacherCount) * 100).toFixed(1)) : 0;
  const teacherAbsentPct = teacherCount > 0 ? Number(((teacherAbsentCount / teacherCount) * 100).toFixed(1)) : 0;

  // Dynamic greeting
  const hour = new Date().getHours();
  let greeting = 'Good afternoon';
  if (hour < 12) greeting = 'Good morning';
  else if (hour >= 17) greeting = 'Good evening';

  // Format date in uppercase Apple style e.g. MONDAY · 31 AUGUST 2026
  const formattedDate = formatEATDate(now, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).toUpperCase().replace(',', ' ·');

  return (
    <DashboardClient 
      todayLogs={todayLogs}
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
      classBreakdown={classBreakdown}
      weekTrend={weekTrend}
      recentMessages={recentMessages}
      greeting={greeting}
      adminName={adminName}
      formattedDate={formattedDate}
    />
  );
}
