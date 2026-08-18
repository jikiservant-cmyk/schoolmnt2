'use server';

import { createAdminClient, createPublicAdminClient } from '@/utils/supabase/admin';
import { 
  isWithinAttendanceSmsWindow, 
  getAttendanceStatusForCheckIn,
  getEatTodayRange,
  getCurrentAttendanceWindowMode
} from '@/lib/attendance-window';
import bcrypt from 'bcryptjs';

export interface StudentAttendanceStatus {
  id: string;
  full_name: string;
  device_user_id: string | null;
  has_checked_in: boolean;
  check_in_time: string | null;
  check_in_status: 'present' | 'late' | null;
  has_checked_out: boolean;
  check_out_time: string | null;
}

export async function verifyTeacherPin(classId: string, pin: string) {
  const adminClient = createAdminClient();
  const cleanPin = pin.trim().toUpperCase();

  // 1. Fetch class to get school_id
  const { data: cls, error: clsError } = await adminClient
    .from('classes')
    .select('id, school_id')
    .eq('id', classId)
    .maybeSingle();

  if (clsError || !cls) {
    console.error('verifyTeacherPin class fetch error:', clsError, 'classId:', classId);
    return { success: false, error: 'Class not found.' };
  }

  // 2. Fetch active teachers in this school
  const { data: teachers, error: tError } = await adminClient
    .from('people')
    .select('id, full_name, role, school_id, device_user_id')
    .eq('school_id', cls.school_id)
    .eq('role', 'teacher')
    .eq('is_active', true);

  if (tError || !teachers || teachers.length === 0) {
    return { success: false, error: 'No active teachers found for this school.' };
  }

  // 3. Fetch staff_users pin_hash records for these teachers
  const teacherIds = teachers.map(t => t.id);
  const { data: staffUsers } = await adminClient
    .from('staff_users')
    .select('id, person_id, pin_hash')
    .in('person_id', teacherIds);

  let matchedTeacher = null;

  if (staffUsers && staffUsers.length > 0) {
    for (const su of staffUsers) {
      if (su.pin_hash) {
        const isMatch = bcrypt.compareSync(cleanPin, su.pin_hash) || bcrypt.compareSync(pin.trim(), su.pin_hash);
        if (isMatch) {
          matchedTeacher = teachers.find(t => t.id === su.person_id);
          break;
        }
      }
    }
  }

  // Fallback check: if device_user_id (ZKTeco numeric ID) matches directly
  if (!matchedTeacher) {
    matchedTeacher = teachers.find(t => 
      t.device_user_id && (t.device_user_id.trim() === pin.trim() || t.device_user_id.trim().toUpperCase() === cleanPin)
    );
  }

  if (!matchedTeacher) {
    return { success: false, error: 'Invalid Teacher Attendance PIN / Passcode.' };
  }

  return { success: true, teacher: matchedTeacher };
}

export async function getStudentsForClass(classId: string) {
  const adminClient = createAdminClient();
  const { data: students, error } = await adminClient
    .from('people')
    .select('id, full_name, device_user_id')
    .eq('class_id', classId)
    .eq('role', 'student')
    .eq('is_active', true)
    .order('full_name');

  if (error) {
    return { error: 'Failed to fetch students.' };
  }

  if (!students || students.length === 0) {
    return { students: [], activeWindowMode: getCurrentAttendanceWindowMode() };
  }

  // Fetch today's attendance logs in EAT for these students
  const { startIso, endIso } = getEatTodayRange();
  const studentIds = students.map(s => s.id);

  const { data: logs } = await adminClient
    .from('attendance_logs')
    .select('person_id, attendance_type, status, occurred_at')
    .in('person_id', studentIds)
    .gte('occurred_at', startIso)
    .lte('occurred_at', endIso)
    .order('occurred_at', { ascending: true });

  const logMap = new Map<string, { checkIn?: any; checkOut?: any }>();

  for (const log of logs || []) {
    const entry = logMap.get(log.person_id) || {};
    if (log.attendance_type === 'check_in' && !entry.checkIn) {
      entry.checkIn = log;
    } else if (log.attendance_type === 'check_out' && !entry.checkOut) {
      entry.checkOut = log;
    }
    logMap.set(log.person_id, entry);
  }

  const enrichedStudents: StudentAttendanceStatus[] = students.map(student => {
    const studentLogs = logMap.get(student.id);
    const checkInLog = studentLogs?.checkIn;
    const checkOutLog = studentLogs?.checkOut;

    const checkInTime = checkInLog?.occurred_at
      ? new Date(checkInLog.occurred_at).toLocaleTimeString('en-US', {
          timeZone: 'Africa/Kampala',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        })
      : null;

    const checkOutTime = checkOutLog?.occurred_at
      ? new Date(checkOutLog.occurred_at).toLocaleTimeString('en-US', {
          timeZone: 'Africa/Kampala',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        })
      : null;

    return {
      id: student.id,
      full_name: student.full_name,
      device_user_id: student.device_user_id,
      has_checked_in: !!checkInLog,
      check_in_time: checkInTime,
      check_in_status: checkInLog ? (checkInLog.status as 'present' | 'late') : null,
      has_checked_out: !!checkOutLog,
      check_out_time: checkOutTime,
    };
  });

  return { 
    students: enrichedStudents,
    activeWindowMode: getCurrentAttendanceWindowMode()
  };
}

export async function submitClassAttendance(
  classId: string,
  teacherId: string,
  presentStudentIds: string[],
  absentStudentIds: string[],
  attendanceType: 'check_in' | 'check_out' = 'check_in'
) {
  const adminClient = createAdminClient();

  // Get class and school info
  const { data: cls } = await adminClient
    .from('classes')
    .select('id, name, school_id')
    .eq('id', classId)
    .maybeSingle();

  if (!cls) return { success: false, error: 'Class not found' };
  
  // Resolve staff_users.id for marked_by FK constraint
  let markedByStaffUserId: string | null = null;
  if (teacherId) {
    const { data: staffUser } = await adminClient
      .from('staff_users')
      .select('id')
      .or(`id.eq.${teacherId},person_id.eq.${teacherId}`)
      .maybeSingle();

    if (staffUser) {
      markedByStaffUserId = staffUser.id;
    }
  }

  const now = new Date();
  const { startIso, endIso } = getEatTodayRange(now);

  // Check today's existing attendance logs for these students (ensure strictly ONE mark per time frame)
  let eligibleStudentIds = presentStudentIds;
  if (presentStudentIds.length > 0) {
    const { data: existingLogs } = await adminClient
      .from('attendance_logs')
      .select('person_id, attendance_type')
      .in('person_id', presentStudentIds)
      .gte('occurred_at', startIso)
      .lte('occurred_at', endIso);

    const alreadyRecordedSet = new Set(
      (existingLogs || [])
        .filter(l => l.attendance_type === attendanceType)
        .map(l => l.person_id)
    );

    eligibleStudentIds = presentStudentIds.filter(id => !alreadyRecordedSet.has(id));
  }

  if (presentStudentIds.length > 0 && eligibleStudentIds.length === 0) {
    return {
      success: true,
      skipped: true,
      count: 0,
      message: `Selected student(s) are already marked for ${attendanceType === 'check_in' ? 'Morning Check-In' : 'Evening Check-Out'} today.`
    };
  }

  const attendanceStatus: 'present' | 'late' = attendanceType === 'check_in'
    ? getAttendanceStatusForCheckIn(now)
    : 'present';

  const presentLogs = eligibleStudentIds.map(studentId => ({
    id: crypto.randomUUID(),
    school_id: cls.school_id,
    person_id: studentId,
    class_id_at_time: cls.id,
    class_name_at_time: cls.name,
    status: attendanceStatus,
    attendance_type: attendanceType,
    marked_by: markedByStaffUserId,
    occurred_at: now.toISOString(),
    source: 'manual' as const,
    created_at: now.toISOString(),
  }));

  if (presentLogs.length > 0) {
    const { error: insertError } = await adminClient
      .from('attendance_logs')
      .insert(presentLogs);
      
    if (insertError) {
      console.error("Error inserting manual attendance", insertError);
      return { success: false, error: 'Failed to save attendance records.' };
    }
  }

  // --- SEND SMS TO PARENTS ---
  if (eligibleStudentIds.length > 0) {
    try {
      // 1. Fetch Students
      const { data: studentsData } = await adminClient
        .from('people')
        .select('id, full_name')
        .in('id', eligibleStudentIds);
        
      // 2. Fetch Parents (prefer primary contact, fallback to any linked parent with phone)
      const { data: parentsData } = await adminClient
        .from('student_parents')
        .select('student_id, parent_id, is_primary_contact, parents(phone, full_name)')
        .in('student_id', eligibleStudentIds);

      if (studentsData && parentsData && parentsData.length > 0) {
        // Map of studentId -> { parentId, parentName, phone, is_primary_contact }
        const notificationsToSend: any[] = [];
        const studentMap = new Map(studentsData.map(s => [s.id, s.full_name]));
        
        const parentByStudent = new Map<string, any>();
        for (const sp of parentsData) {
          const phone = (sp.parents as any)?.phone;
          if (!phone) continue;
          
          const existing = parentByStudent.get(sp.student_id);
          if (!existing || (!existing.is_primary_contact && sp.is_primary_contact)) {
            parentByStudent.set(sp.student_id, {
              parentId: sp.parent_id,
              parentName: (sp.parents as any)?.full_name,
              phone: phone,
              is_primary_contact: sp.is_primary_contact
            });
          }
        }
        
        for (const [sId, sName] of studentMap.entries()) {
          const pInfo = parentByStudent.get(sId);
          if (pInfo) {
            notificationsToSend.push({
              studentId: sId,
              parentId: pInfo.parentId,
              studentName: sName,
              parentName: pInfo.parentName,
              phone: pInfo.phone
            });
          }
        }
        

        if (notificationsToSend.length > 0) {
          const windowCheck = isWithinAttendanceSmsWindow(attendanceType, now);

          if (!windowCheck.allowed) {
            console.log(`[Class Manual Attendance] Recorded attendance for ${presentLogs.length} students, but SMS dispatch skipped: ${windowCheck.reason}`);
          } else {
            const timestampStr = windowCheck.eatTimeStr || now.toLocaleTimeString('en-US', { 
              hour: '2-digit', 
              minute: '2-digit', 
              hour12: true 
            });

            for (const notif of notificationsToSend) {
              let smsMessageText = `Dear Parent,`;
              if (attendanceType === 'check_in') {
                smsMessageText += attendanceStatus === 'late'
                  ? ` your child ${notif.studentName} checked IN LATE at school at ${timestampStr}.`
                  : ` your child ${notif.studentName} checked IN at school successfully at ${timestampStr}.`;
              } else {
                smsMessageText += ` your child ${notif.studentName} checked OUT of school and is heading home at ${timestampStr}.`;
              }

              // Queue the notification in school.notifications
              await adminClient
                .from('notifications')
                .insert({
                  school_id: cls.school_id,
                  recipient_type: 'parent',
                  recipient_id: notif.parentId,
                  recipient_phone_snapshot: notif.phone,
                  channel: 'sms',
                  notification_type: 'attendance',
                  status: 'pending',
                  message: smsMessageText
                });
            }
            console.log(`[Class Manual Attendance] Queued ${notificationsToSend.length} SMS notifications for ${attendanceType} at ${timestampStr} EAT`);
          }
        }
      }
    } catch (e) {
      console.error('Failed to send class attendance SMS messages', e);
    }
  }
  
  return { success: true, count: presentLogs.length };
}
