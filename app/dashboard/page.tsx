import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import DashboardClient from './DashboardClient';
import { getEATDayRange, getEATDateKey, formatEATDate } from '@/lib/eat-time';
import { getSchoolSettings, DEFAULT_SCHOOL_POLICY_SETTINGS } from '@/lib/school-settings';

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
  let adminName = 'Admin';
  let schoolTimeZone = DEFAULT_SCHOOL_POLICY_SETTINGS.timeZone;
  let academicTermLabel = DEFAULT_SCHOOL_POLICY_SETTINGS.academicTermLabel;

  const now = new Date();
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      // Must have user context for dashboard
      throw new Error('Unauthorized');
    }

    if (user) {
      const { data: staffData } = await supabase
        .from('staff_users')
        .select('people(full_name)')
        .eq('auth_user_id', user.id)
        .maybeSingle();

      if (staffData && staffData.people) {
        const p = staffData.people as any;
        adminName = p.full_name?.split(' ')[0] || 'Admin';
      } else {
        adminName = user.user_metadata?.full_name?.split(' ')[0] || 'Admin';
      }
    }

    // Fetch counts and daily logs
    const schoolIdMatch = await supabase.rpc('auth_school_id').then(res => res.data);
    
    // We must try to determine the schoolId if possible
    let targetSchoolId = schoolIdMatch;
    if (!targetSchoolId && user) {
       const { data: stf } = await supabase.from('staff_users').select('people(school_id)').eq('auth_user_id', user.id).maybeSingle();
       if (stf?.people && (stf.people as any).school_id) targetSchoolId = (stf.people as any).school_id;
    }

    if (!targetSchoolId) {
      throw new Error('Tenant context required. Please log in with an assigned school.');
    }

    const schoolSettings = await getSchoolSettings(createAdminClient(), targetSchoolId);
    schoolTimeZone = schoolSettings.timeZone;
    academicTermLabel = schoolSettings.academicTermLabel;

    // 1. Get current date range in school's configured timezone
    const todayRange = getEATDayRange(now, schoolTimeZone);
    const todayKey = todayRange.dateStr;

    // 2. Calculate the 7 days of the current week (Monday through Sunday in school's timezone)
    const [ty, tm, td] = todayKey.split('-').map(Number);
    const anchorUtc = new Date(Date.UTC(ty, tm - 1, td, 12, 0, 0));
    const dayOfWeek = anchorUtc.getUTCDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayUtc = new Date(anchorUtc);
    mondayUtc.setUTCDate(anchorUtc.getUTCDate() - daysSinceMonday);

    const weekDaysData: { dayName: string; dateKey: string; dateLabel: string; startIso: string; endIso: string; isToday: boolean; isFuture: boolean }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(mondayUtc);
      d.setUTCDate(mondayUtc.getUTCDate() + i);
      const dayRange = getEATDayRange(d, schoolTimeZone);
      const isToday = dayRange.dateStr === todayKey;
      const isFuture = dayRange.dateStr > todayKey;

      weekDaysData.push({
        dayName: dayNames[i],
        dateKey: dayRange.dateStr,
        dateLabel: formatEATDate(d, { month: 'short', day: 'numeric' }, schoolTimeZone),
        startIso: dayRange.startIso,
        endIso: dayRange.endIso,
        isToday,
        isFuture,
      });
    }

    const weekStartIso = weekDaysData[0].startIso;
    const weekEndIso = weekDaysData[6].endIso;

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
      supabase.from('people').select('*', { count: 'exact', head: true }).eq('school_id', targetSchoolId).eq('role', 'student'),
      supabase.from('people').select('*', { count: 'exact', head: true }).eq('school_id', targetSchoolId).in('role', ['teacher', 'admin', 'support_staff']),
      supabase.from('classes').select('id, name').eq('school_id', targetSchoolId).order('name'),
      supabase.from('people').select('id, full_name, role, class_id').eq('school_id', targetSchoolId).eq('role', 'student'),
      supabase.from('devices').select('id, serial_number, label, location_label, ip_address, firmware_version, device_type, config, last_seen_at, is_active, created_at, school_id').eq('school_id', targetSchoolId).limit(5),
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
        .eq('school_id', targetSchoolId)
        .gte('occurred_at', todayRange.startIso)
        .lte('occurred_at', todayRange.endIso)
        .order('occurred_at', { ascending: false }),
      // Week's attendance logs for trend calculation
      supabase
        .from('attendance_logs')
        .select('id, person_id, status, occurred_at, people:people(role)')
        .eq('school_id', targetSchoolId)
        .gte('occurred_at', weekStartIso)
        .lte('occurred_at', weekEndIso),
      supabase
        .from('notifications')
        .select('*')
        .eq('school_id', targetSchoolId)
        .order('created_at', { ascending: false })
        .limit(10)
    ]);

    studentCount = students || 0;
    teacherCount = teachers || 0;
    classCount = classesData?.length || 0;
    devicesList = devicesData || [];
    todayLogs = todayLogsData || [];
    recentMessages = messagesData || [];

    // Calculate unique student & teacher daily attendance across 2 daily slots
    // (`1 check_in` + `1 check_out` MAX per person per day):
    //   - Morning `check_in` establishes daily punctuality (`present` vs `late`)
    //   - Evening `check_out` NEVER overwrites a morning `late` arrival to `present`
    //   - Manual `absent` is NEVER counted as attended
    const buildDailyPersonMap = (rows: any[], matchStudent: boolean) => {
      const byPerson = new Map<string, { checkIn?: any; checkOut?: any; fallback?: any }>();
      for (const log of rows) {
        const personId = log.person_id || log.people?.id;
        if (!personId) continue;
        const role = log.people?.role || 'student';
        const isStudent = role === 'student';
        if (isStudent !== matchStudent) continue;

        const entry = byPerson.get(personId) || {};
        if (log.attendance_type === 'check_in') {
          entry.checkIn = log;
        } else if (log.attendance_type === 'check_out') {
          entry.checkOut = log;
        } else {
          entry.fallback = log;
        }
        byPerson.set(personId, entry);
      }

      const resolved = new Map<string, 'present' | 'late'>();
      for (const [personId, entry] of byPerson.entries()) {
        if (entry.checkIn && entry.checkIn.status !== 'absent') {
          resolved.set(personId, entry.checkIn.status === 'late' ? 'late' : 'present');
        } else if (entry.checkOut && entry.checkOut.status !== 'absent') {
          resolved.set(personId, 'present');
        } else if (entry.fallback && entry.fallback.status !== 'absent') {
          resolved.set(personId, entry.fallback.status === 'late' ? 'late' : 'present');
        }
      }
      return resolved;
    };

    const studentLogsMap = buildDailyPersonMap(todayLogs, true);
    const teacherLogsMap = buildDailyPersonMap(todayLogs, false);

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
          const stStatus = studentLogsMap.get(id);
          if (stStatus === 'present') presentToday++;
          else if (stStatus === 'late') lateToday++;
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

    // Calculate 7-Day Week Trend from weekLogsData (unique students with non-absent attendance)
    const logsByDateKey = new Map<string, Set<string>>();
    (weekLogsData || []).forEach((l: any) => {
      if ((l.people?.role || 'student') === 'student' && l.person_id && l.status !== 'absent') {
        const key = getEATDateKey(l.occurred_at, schoolTimeZone);
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

  // Unique student & staff daily counts (never double-counted across check_in + check_out!)
  let presentCount = 0;
  let lateCount = 0;
  let teacherPresentCount = 0;
  let teacherLateCount = 0;

  {
    const seenStudent = new Map<string, 'present' | 'late'>();
    const seenTeacher = new Map<string, 'present' | 'late'>();
    for (const l of todayLogs) {
      const pid = l.person_id || l.people?.id;
      if (!pid || l.status === 'absent') continue;
      const role = l.people?.role || 'student';
      const target = role === 'student' ? seenStudent : seenTeacher;
      if (l.attendance_type === 'check_in') {
        target.set(pid, l.status === 'late' ? 'late' : 'present');
      } else if (!target.has(pid)) {
        target.set(pid, l.status === 'late' ? 'late' : 'present');
      }
    }
    for (const st of seenStudent.values()) {
      if (st === 'late') lateCount++;
      else presentCount++;
    }
    for (const st of seenTeacher.values()) {
      if (st === 'late') teacherLateCount++;
      else teacherPresentCount++;
    }
  }

  const absentCount = Math.max(0, studentCount - (presentCount + lateCount));
  const presentPct = studentCount > 0 ? Number(((presentCount / studentCount) * 100).toFixed(1)) : 0;
  const latePct = studentCount > 0 ? Number(((lateCount / studentCount) * 100).toFixed(1)) : 0;
  const absentPct = studentCount > 0 ? Number(((absentCount / studentCount) * 100).toFixed(1)) : 0;

  const teacherAbsentCount = Math.max(0, teacherCount - (teacherPresentCount + teacherLateCount));
  const teacherPresentPct = teacherCount > 0 ? Number(((teacherPresentCount / teacherCount) * 100).toFixed(1)) : 0;
  const teacherLatePct = teacherCount > 0 ? Number(((teacherLateCount / teacherCount) * 100).toFixed(1)) : 0;
  const teacherAbsentPct = teacherCount > 0 ? Number(((teacherAbsentCount / teacherCount) * 100).toFixed(1)) : 0;

  // Dynamic greeting in school's configured timezone
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: schoolTimeZone,
    hour: 'numeric',
    hour12: false,
  }).format(now);
  const hour = parseInt(hourStr, 10) % 24;
  let greeting = 'Good afternoon';
  if (hour < 12) greeting = 'Good morning';
  else if (hour >= 17) greeting = 'Good evening';

  // Format date in uppercase Apple style e.g. MONDAY · 31 AUGUST 2026
  const formattedDate = formatEATDate(
    now,
    {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    },
    schoolTimeZone
  )
    .toUpperCase()
    .replace(',', ' ·');

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
      academicTermLabel={academicTermLabel}
    />
  );
}
