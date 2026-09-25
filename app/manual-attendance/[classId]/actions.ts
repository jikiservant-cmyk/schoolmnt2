'use server';

import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { 
  isWithinAttendanceSmsWindow, 
  getAttendanceStatusForCheckIn,
  getEatTodayRange,
  getCurrentAttendanceWindowMode
} from '@/lib/attendance-window';
import bcrypt from 'bcryptjs';
import { createAttendanceIdentity } from '@/lib/attendance/idempotency';
import {
  getEligibleStudentIds,
  isAttendanceType,
  validateAttendanceSelection,
} from '@/lib/attendance/marking';

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

// Durable rate limiting via staff_users table
// Requires migration: ALTER TABLE staff_users ADD COLUMN failed_attempts INT DEFAULT 0, ADD COLUMN locked_until TIMESTAMPTZ;

export async function verifyTeacherPin(classId: string, teacherId: string, pin: string) {
  await new Promise(resolve => setTimeout(resolve, 300));
  if (typeof classId !== 'string' || !classId || typeof teacherId !== 'string' || !teacherId || typeof pin !== 'string' || !pin.trim() || pin.length > 64) {
    return { success: false, error: 'Invalid attendance credentials.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'Unauthorized.' };

  const { data: schoolId, error: schoolError } = await supabase.rpc('auth_school_id');
  if (schoolError || !schoolId) return { success: false, error: 'School context not found.' };

  // Validate both the class and teacher BEFORE reading or mutating any PIN state.
  const { data: cls, error: classError } = await supabase
    .from('classes')
    .select('id')
    .eq('id', classId)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (classError || !cls) return { success: false, error: 'Class not found or access denied.' };

  const adminClient = createAdminClient();
  const { data: teacher, error: teacherError } = await adminClient
    .from('people')
    .select('id, full_name, role, school_id, device_user_id, is_active')
    .eq('id', teacherId)
    .eq('school_id', schoolId)
    .eq('role', 'teacher')
    .eq('is_active', true)
    .maybeSingle();
  if (teacherError || !teacher) return { success: false, error: 'Teacher not found or access denied.' };

  const { data: staffUser, error: staffError } = await adminClient
    .from('staff_users')
    .select('id, person_id, pin_hash, failed_attempts, locked_until')
    .eq('person_id', teacher.id)
    .maybeSingle();
  if (staffError || !staffUser) return { success: false, error: 'Teacher PIN is not configured.' };

  if (staffUser.locked_until && new Date(staffUser.locked_until).getTime() > Date.now()) {
    const mins = Math.ceil((new Date(staffUser.locked_until).getTime() - Date.now()) / 60000);
    return { success: false, error: `Locked for ${mins} minute(s).` };
  }

  const cleanPin = pin.trim().toUpperCase();
  const isMatch = staffUser.pin_hash && (
    await bcrypt.compare(cleanPin, staffUser.pin_hash) ||
    await bcrypt.compare(pin.trim(), staffUser.pin_hash)
  );

  if (!isMatch) {
    const newFailures = (staffUser.failed_attempts || 0) + 1;
    const update: Record<string, unknown> = { failed_attempts: newFailures };
    if (newFailures >= 5) update.locked_until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { error: updateError } = await adminClient
      .from('staff_users')
      .update(update)
      .eq('id', staffUser.id)
      .eq('person_id', teacher.id);
    if (updateError) {
      console.error('Failed to update teacher PIN lockout state:', updateError);
      return { success: false, error: 'PIN verification is temporarily unavailable.' };
    }
    return { success: false, error: 'Invalid PIN.' };
  }

  const { error: resetError } = await adminClient
    .from('staff_users')
    .update({ failed_attempts: 0, locked_until: null })
    .eq('id', staffUser.id)
    .eq('person_id', teacher.id);
  if (resetError) {
    console.error('Failed to reset teacher PIN lockout state:', resetError);
    return { success: false, error: 'PIN verification is temporarily unavailable.' };
  }

  return { success: true, teacher };
}

export async function getTeachersForClass(classId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'Unauthorized.' };

  const { data: schoolId } = await supabase.rpc('auth_school_id');
  if (!schoolId) return { success: false, error: 'School context not found.' };
  
  const { data: cls } = await supabase
    .from('classes')
    .select('id')
    .eq('id', classId)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (!cls) return { success: false, error: 'Class not found or access denied.' };

  const { data: teachers, error: teachersError } = await supabase
    .from('people')
    .select('id, full_name')
    .eq('school_id', schoolId)
    .eq('role', 'teacher')
    .eq('is_active', true)
    .order('full_name');

  if (teachersError) return { success: false, error: 'Failed to load teachers.' };
  return { success: true, teachers: teachers || [] };
}

export async function getStudentsForClass(classId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized.' };

  const { data: schoolId } = await supabase.rpc('auth_school_id');
  if (!schoolId) return { error: 'School context not found.' };

  const { data: cls } = await supabase
    .from('classes')
    .select('id')
    .eq('id', classId)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (!cls) return { error: 'Class not found or access denied.' };

  const { data: students, error } = await supabase
    .from('people')
    .select('id, full_name, device_user_id')
    .eq('class_id', classId)
    .eq('school_id', schoolId)
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

  const { data: logs, error: logsError } = await supabase
    .from('attendance_logs')
    .select('person_id, attendance_type, status, occurred_at')
    .eq('school_id', schoolId)
    .in('person_id', studentIds)
    .gte('occurred_at', startIso)
    .lte('occurred_at', endIso)
    .order('occurred_at', { ascending: true });

  if (logsError) {
    console.error('Failed to fetch school-scoped attendance status:', logsError);
    return { error: 'Failed to load attendance status.' };
  }

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
  attendanceType: 'check_in' | 'check_out' = 'check_in',
  pin: string = ''
) {
  if (typeof classId !== 'string' || !classId || typeof teacherId !== 'string' || !teacherId || !isAttendanceType(attendanceType)) {
    return { success: false, error: 'Invalid attendance request.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'Unauthorized.' };

  const { data: schoolId, error: schoolError } = await supabase.rpc('auth_school_id');
  if (schoolError || !schoolId) return { success: false, error: 'School context not found.' };

  const adminClient = createAdminClient();

  // Re-verify the teacher PIN and tenant-scoped class on every write.
  const pinVerification = await verifyTeacherPin(classId, teacherId, pin);
  if (!pinVerification.success) {
    return { success: false, error: pinVerification.error || 'Invalid Teacher PIN.' };
  }

  const { data: cls, error: classError } = await supabase
    .from('classes')
    .select('id, name, school_id')
    .eq('id', classId)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (classError || !cls) return { success: false, error: 'Class not found or access denied.' };

  // This is the allow-list for IDs provided by the browser. It is explicitly
  // scoped by both class and school before any service-role write is attempted.
  const { data: classStudents, error: studentsError } = await adminClient
    .from('people')
    .select('id')
    .eq('class_id', classId)
    .eq('school_id', schoolId)
    .eq('role', 'student')
    .eq('is_active', true);
  if (studentsError) {
    console.error('Failed to validate class roster for attendance:', studentsError);
    return { success: false, error: 'Could not validate the class roster.' };
  }

  const selection = validateAttendanceSelection(
    presentStudentIds,
    absentStudentIds,
    new Set((classStudents || []).map(student => student.id))
  );
  if (!selection.ok) return { success: false, error: selection.error };

  // Resolve the already-validated teacher's staff row for the audit FK.
  const { data: staffUser, error: staffError } = await adminClient
    .from('staff_users')
    .select('id')
    .eq('person_id', teacherId)
    .maybeSingle();
  if (staffError || !staffUser) {
    console.error('Could not resolve teacher audit identity:', staffError);
    return { success: false, error: 'Teacher attendance credentials are unavailable.' };
  }
  const markedByStaffUserId: string | null = staffUser.id;

  const now = new Date();
  const { startIso, endIso } = getEatTodayRange(now);
  let existingLogs: Array<{ person_id: string; attendance_type: string }> = [];
  const selectedStudentIds = Array.from(new Set([
    ...selection.presentStudentIds,
    ...selection.absentStudentIds,
  ]));

  if (selectedStudentIds.length > 0) {
    const { data, error: attendanceQueryError } = await adminClient
      .from('attendance_logs')
      .select('person_id, attendance_type')
      .eq('school_id', schoolId)
      .in('person_id', selectedStudentIds)
      .gte('occurred_at', startIso)
      .lte('occurred_at', endIso);
    if (attendanceQueryError) {
      console.error('Failed checking existing attendance marks:', attendanceQueryError);
      return { success: false, error: 'Could not verify existing attendance marks.' };
    }
    existingLogs = data || [];
  }

  const eligibleStudentIds = getEligibleStudentIds(
    selection.presentStudentIds,
    attendanceType,
    existingLogs
  );
  const alreadyMarkedIds = new Set(
    existingLogs
      .filter(log => log.attendance_type === attendanceType)
      .map(log => log.person_id)
  );
  const eligibleAbsentStudentIds = selection.absentStudentIds.filter(id => !alreadyMarkedIds.has(id));
  const skippedBeforeInsert =
    selection.presentStudentIds.length - eligibleStudentIds.length +
    selection.absentStudentIds.length - eligibleAbsentStudentIds.length;

  if (eligibleStudentIds.length === 0 && eligibleAbsentStudentIds.length === 0) {
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

  const presentLogs = eligibleStudentIds.map(studentId => {
    const identity = createAttendanceIdentity(schoolId, studentId, attendanceType, now);
    return {
    id: identity.id,
    idempotency_key: identity.idempotency_key,
    school_id: schoolId,
    person_id: studentId,
    class_id_at_time: cls.id,
    class_name_at_time: cls.name,
    status: attendanceStatus,
    attendance_type: attendanceType,
    marked_by: markedByStaffUserId,
    occurred_at: now.toISOString(),
    source: 'manual' as const,
    created_at: now.toISOString(),
    };
  });

  const absentLogs = eligibleAbsentStudentIds.map(studentId => {
    const identity = createAttendanceIdentity(schoolId, studentId, attendanceType, now);
    return {
    id: identity.id,
    idempotency_key: identity.idempotency_key,
    school_id: schoolId,
    person_id: studentId,
    class_id_at_time: cls.id,
    class_name_at_time: cls.name,
    status: 'absent' as const,
    attendance_type: attendanceType,
    marked_by: markedByStaffUserId,
    occurred_at: now.toISOString(),
    source: 'manual' as const,
    created_at: now.toISOString(),
    };
  });

  const allLogs = [...presentLogs, ...absentLogs];
  let insertedAttendanceIds = new Set<string>();
  if (allLogs.length > 0) {
    const { data: insertedRows, error: insertError } = await adminClient
      .from('attendance_logs')
      .upsert(allLogs, {
        onConflict: 'school_id,idempotency_key',
        ignoreDuplicates: true,
      })
      .select('id');
    if (insertError) {
      console.error('Error inserting manual attendance:', insertError);
      return { success: false, error: 'Failed to save attendance records.' };
    }
    insertedAttendanceIds = new Set((insertedRows || []).map(row => row.id));
  }

  // Attendance is committed before notifications are queued. Queue failures are
  // returned as an explicit warning and do not falsely roll back a valid mark.
  let smsQueuedCount = 0;
  let smsWarning: string | undefined;
  if (eligibleStudentIds.length > 0) {
    const windowCheck = isWithinAttendanceSmsWindow(attendanceType, now);
    if (windowCheck.allowed) {
      const [{ data: studentsData, error: peopleError }, { data: parentsData, error: parentLinksError }] = await Promise.all([
        adminClient
          .from('people')
          .select('id, full_name')
          .eq('school_id', schoolId)
          .in('id', eligibleStudentIds),
        adminClient
          .from('student_parents')
          .select('student_id, parent_id, is_primary_contact, parents(phone, full_name, school_id)')
          .in('student_id', eligibleStudentIds),
      ]);

      if (peopleError || parentLinksError) {
        console.error('Failed resolving same-school SMS recipients:', peopleError || parentLinksError);
        smsWarning = 'Attendance was saved, but SMS recipients could not be verified.';
      } else {
        const studentMap = new Map((studentsData || []).map(student => [student.id, student.full_name]));
        const parentByStudent = new Map<string, { parentId: string; phone: string; isPrimary: boolean }>();
        for (const link of parentsData || []) {
          const parent = Array.isArray(link.parents) ? link.parents[0] : link.parents;
          if (!parent || parent.school_id !== schoolId || !parent.phone) continue;
          const previous = parentByStudent.get(link.student_id);
          if (!previous || (!previous.isPrimary && link.is_primary_contact)) {
            parentByStudent.set(link.student_id, {
              parentId: link.parent_id,
              phone: parent.phone,
              isPrimary: Boolean(link.is_primary_contact),
            });
          }
        }

        const attendanceIdByStudent = new Map(presentLogs.map(log => [log.person_id, log.id]));
        const timestampStr = windowCheck.eatTimeStr || now.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });
        const notificationsToQueue = eligibleStudentIds.flatMap(studentId => {
          const studentName = studentMap.get(studentId);
          const parent = parentByStudent.get(studentId);
          const attendanceId = attendanceIdByStudent.get(studentId);
          if (!studentName || !parent || !attendanceId) return [];

          const message = attendanceType === 'check_in'
            ? `Dear Parent, your child ${studentName} checked IN ${attendanceStatus === 'late' ? 'LATE ' : ''}at school at ${timestampStr}.`
            : `Dear Parent, your child ${studentName} checked OUT of school successfully at ${timestampStr}.`;
          return [{
            school_id: schoolId,
            recipient_type: 'parent',
            recipient_id: parent.parentId,
            recipient_phone_snapshot: parent.phone,
            channel: 'sms',
            notification_type: 'attendance',
            related_table: 'attendance_logs',
            related_id: attendanceId,
            message,
            status: 'pending',
          }];
        });

        if (notificationsToQueue.length > 0) {
          const { data: queuedRows, error: queueError } = await adminClient
            .from('notifications')
            .upsert(notificationsToQueue, {
              onConflict: 'school_id,notification_type,related_id,channel',
              ignoreDuplicates: true,
            })
            .select('id');
          if (queueError) {
            console.error('Failed to queue attendance SMS notifications:', queueError);
            smsWarning = 'Attendance was saved, but its SMS notification could not be queued.';
          } else {
            smsQueuedCount = queuedRows?.length || 0;
          }
        } else if (eligibleStudentIds.some(id => !parentByStudent.has(id))) {
          smsWarning = 'Attendance was saved, but one or more students have no verified same-school guardian contact.';
        }
      }
    } else {
      console.info(`[Manual Attendance] SMS skipped: ${windowCheck.reason}`);
    }
  }

  return {
    success: true,
    count: presentLogs.filter(log => insertedAttendanceIds.has(log.id)).length,
    absentCount: absentLogs.filter(log => insertedAttendanceIds.has(log.id)).length,
    skippedDuplicates: skippedBeforeInsert + allLogs.length - insertedAttendanceIds.size,
    smsQueuedCount,
    smsWarning,
  };
}
