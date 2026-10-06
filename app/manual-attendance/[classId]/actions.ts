'use server';

import { checkSchoolAdmin } from '@/lib/auth-guard';
import { consumeRateLimit, resetRateLimit } from '@/lib/security/rate-limit';
import { createAdminClient } from '@/utils/supabase/admin';
import { queueNotifications, attendanceSmsKey } from '@/lib/notifications/queue';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIN_RE = /^[A-Za-z0-9]{4,12}$/;

const MAX_PIN_FAILURES = 5;
const PIN_LOCK_MS = 10 * 60 * 1000;
const GENERIC_PIN_ERROR = 'Invalid teacher or PIN.';

async function requireAdminContext() {
  const result = await checkSchoolAdmin();
  if (!result.ok) {
    return { ok: false as const, error: result.reason === 'unauthenticated' ? 'Unauthorized.' : 'Access denied.' };
  }
  return { ok: true as const, supabase: result.supabase, schoolId: result.schoolId, user: result.user };
}

type VerifiedTeacher = {
  teacher: { id: string; full_name: string; role: string; school_id: string; device_user_id: string | null };
  staffUserId: string;
};

/**
 * Core PIN verification, always scoped to the caller's school.
 *
 * Fixes vs. previous implementation:
 *  - staff_users was looked up by person_id WITHOUT a school filter before the
 *    tenant check, so an admin of School A could burn PIN attempts and lock out
 *    teachers of School B (cross-tenant DoS) given their person UUID.
 *  - DB-backed failure counter was read-modify-write → N parallel requests all
 *    saw the same count and bypassed the 5-attempt lockout. An in-process
 *    limiter is now consumed *before* bcrypt runs.
 *  - "Teacher not found" vs "Invalid PIN" allowed enumeration → single message.
 *  - Lockout columns are standardised on failed_attempts / locked_until (the
 *    reset action previously wrote pin_failed_attempts / pin_locked_until, so a
 *    PIN reset never actually cleared a lockout).
 */
async function verifyTeacherPinScoped(
  schoolId: string,
  classId: string,
  teacherId: string,
  pin: string,
  callerId: string
): Promise<{ success: true; data: VerifiedTeacher } | { success: false; error: string }> {
  if (typeof classId !== 'string' || !UUID_RE.test(classId)) return { success: false, error: 'Invalid class.' };
  if (typeof teacherId !== 'string' || !UUID_RE.test(teacherId)) return { success: false, error: GENERIC_PIN_ERROR };
  if (typeof pin !== 'string' || !PIN_RE.test(pin.trim())) return { success: false, error: GENERIC_PIN_ERROR };

  // Throttle before doing any expensive work (bcrypt) — per teacher and per operator session.
  const perTeacher = consumeRateLimit(`pin:teacher:${teacherId}`, MAX_PIN_FAILURES * 2, PIN_LOCK_MS);
  const perCaller = consumeRateLimit(`pin:caller:${callerId}`, 30, PIN_LOCK_MS);
  if (!perTeacher.allowed || !perCaller.allowed) {
    const secs = Math.max(perTeacher.retryAfterSeconds, perCaller.retryAfterSeconds);
    return { success: false, error: `Too many attempts. Locked for ${Math.max(1, Math.ceil(secs / 60))} minute(s).` };
  }

  const adminClient = createAdminClient();

  // 1. Tenant check FIRST: the teacher must be an active teacher in the caller's school.
  const { data: teacher } = await adminClient
    .from('people')
    .select('id, full_name, role, school_id, device_user_id')
    .eq('id', teacherId)
    .eq('school_id', schoolId)
    .eq('role', 'teacher')
    .eq('is_active', true)
    .maybeSingle();

  // 2. The class must belong to the same school.
  const { data: cls } = await adminClient
    .from('classes')
    .select('id')
    .eq('id', classId)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (!teacher || !cls) {
    await bcrypt.compare(pin, getDummyHash()); // equalise timing with the real path
    return { success: false, error: GENERIC_PIN_ERROR };
  }

  // 3. Load credentials (tolerate deployments that haven't added lockout columns yet).
  let staffUser: { id: string; pin_hash: string | null; failed_attempts?: number | null; locked_until?: string | null } | null = null;
  let hasLockoutColumns = true;
  {
    const { data, error } = await adminClient
      .from('staff_users')
      .select('id, pin_hash, failed_attempts, locked_until')
      .eq('person_id', teacher.id)
      .maybeSingle();
    if (error) {
      hasLockoutColumns = false;
      const fallback = await adminClient
        .from('staff_users')
        .select('id, pin_hash')
        .eq('person_id', teacher.id)
        .maybeSingle();
      staffUser = fallback.data;
    } else {
      staffUser = data;
    }
  }

  if (!staffUser || !staffUser.pin_hash) {
    await bcrypt.compare(pin, getDummyHash());
    return { success: false, error: GENERIC_PIN_ERROR };
  }

  if (staffUser.locked_until && new Date(staffUser.locked_until).getTime() > Date.now()) {
    const mins = Math.ceil((new Date(staffUser.locked_until).getTime() - Date.now()) / 60000);
    return { success: false, error: `Too many attempts. Locked for ${mins} minute(s).` };
  }

  // PINs are generated upper-case; accept case-insensitive input.
  const isMatch = await bcrypt.compare(pin.trim().toUpperCase(), staffUser.pin_hash);

  if (!isMatch) {
    if (hasLockoutColumns) {
      const newFailures = (staffUser.failed_attempts || 0) + 1;
      const update: Record<string, unknown> = { failed_attempts: newFailures };
      if (newFailures >= MAX_PIN_FAILURES) update.locked_until = new Date(Date.now() + PIN_LOCK_MS).toISOString();
      await adminClient.from('staff_users').update(update).eq('id', staffUser.id);
    }
    return { success: false, error: GENERIC_PIN_ERROR };
  }

  if (hasLockoutColumns && (staffUser.failed_attempts || staffUser.locked_until)) {
    await adminClient.from('staff_users').update({ failed_attempts: 0, locked_until: null }).eq('id', staffUser.id);
  }
  resetRateLimit(`pin:teacher:${teacherId}`);

  return { success: true, data: { teacher, staffUserId: staffUser.id } };
}

// bcrypt hash of a random value, used only to equalise response timing.
let dummyHash: string | null = null;
function getDummyHash() {
  if (!dummyHash) dummyHash = bcrypt.hashSync(crypto.randomUUID(), 10);
  return dummyHash;
}

export async function verifyTeacherPin(classId: string, teacherId: string, pin: string) {
  const ctx = await requireAdminContext();
  if (!ctx.ok) return { success: false, error: ctx.error };

  const result = await verifyTeacherPinScoped(ctx.schoolId, classId, teacherId, pin, ctx.user.id);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, teacher: result.data.teacher };
}

export async function getTeachersForClass(classId: string) {
  const ctx = await requireAdminContext();
  if (!ctx.ok) return { success: false, error: ctx.error };
  const { supabase, schoolId } = ctx;
  if (typeof classId !== 'string' || !UUID_RE.test(classId)) return { success: false, error: 'Invalid class.' };

  const { data: cls } = await supabase
    .from('classes')
    .select('id')
    .eq('id', classId)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (!cls) return { success: false, error: 'Class not found or access denied.' };

  const { data: teachers } = await supabase
    .from('people')
    .select('id, full_name')
    .eq('school_id', schoolId)
    .eq('role', 'teacher')
    .eq('is_active', true)
    .order('full_name');

  return { success: true, teachers: teachers || [] };
}

export async function getStudentsForClass(classId: string) {
  const ctx = await requireAdminContext();
  if (!ctx.ok) return { error: ctx.error };
  const { supabase, schoolId } = ctx;
  if (typeof classId !== 'string' || !UUID_RE.test(classId)) return { error: 'Invalid class.' };

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

  const { data: logs } = await supabase
    .from('attendance_logs')
    .select('person_id, attendance_type, status, occurred_at')
    .eq('school_id', schoolId)
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
  attendanceType: 'check_in' | 'check_out' = 'check_in',
  pin: string = ''
) {
  const ctx = await requireAdminContext();
  if (!ctx.ok) return { success: false, error: ctx.error };
  const { supabase, schoolId } = ctx;

  // Strict input validation — these arrive straight from the client.
  if (attendanceType !== 'check_in' && attendanceType !== 'check_out') {
    return { success: false, error: 'Invalid attendance type.' };
  }
  if (
    !Array.isArray(presentStudentIds) || !Array.isArray(absentStudentIds) ||
    presentStudentIds.length + absentStudentIds.length > 1000 ||
    ![...presentStudentIds, ...absentStudentIds].every((id) => typeof id === 'string' && UUID_RE.test(id))
  ) {
    return { success: false, error: 'Invalid student reference provided.' };
  }
  presentStudentIds = Array.from(new Set(presentStudentIds));
  absentStudentIds = Array.from(new Set(absentStudentIds)).filter((id) => !presentStudentIds.includes(id));

  const adminClient = createAdminClient();

  // Re-verify Teacher PIN server-side (scoped to this school)
  const pinVerification = await verifyTeacherPinScoped(schoolId, classId, teacherId, pin, ctx.user.id);
  if (!pinVerification.success) {
    return { success: false, error: pinVerification.error || 'Invalid Teacher PIN.' };
  }

  // Get class and school info, scoped by schoolId
  const { data: cls } = await supabase
    .from('classes')
    .select('id, name, school_id')
    .eq('id', classId)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (!cls) return { success: false, error: 'Class not found or access denied' };

  // Validate that all submitted student IDs actually belong to this class
  const { data: classStudents } = await adminClient
    .from('people')
    .select('id')
    .eq('class_id', classId)
    .eq('school_id', schoolId)
    .in('role', ['student']);
    
  const validStudentIds = new Set((classStudents || []).map((s: any) => s.id));
  for (const id of [...presentStudentIds, ...absentStudentIds]) {
    if (!validStudentIds.has(id)) {
      return { success: false, error: 'Invalid student reference provided.' };
    }
  }
  
  // marked_by comes from the verified staff record — never from client input.
  const markedByStaffUserId: string | null = pinVerification.data.staffUserId;

  const now = new Date();
  const { startIso, endIso } = getEatTodayRange(now);

  // Check today's existing attendance logs for these students (ensure strictly ONE mark per time frame)
  let eligibleStudentIds = presentStudentIds;
  if (presentStudentIds.length > 0) {
    const { data: existingLogs } = await adminClient
      .from('attendance_logs')
      .select('person_id, attendance_type')
      .eq('school_id', schoolId)
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

  const absentLogs = absentStudentIds.map(studentId => ({
    id: crypto.randomUUID(),
    school_id: cls.school_id,
    person_id: studentId,
    class_id_at_time: cls.id,
    class_name_at_time: cls.name,
    status: 'absent' as const,
    attendance_type: attendanceType,
    marked_by: markedByStaffUserId,
    occurred_at: now.toISOString(),
    source: 'manual' as const,
    created_at: now.toISOString(),
  }));

  const allLogs = [...presentLogs, ...absentLogs];

  if (allLogs.length > 0) {
    const { error: insertError } = await adminClient
      .from('attendance_logs')
      .insert(allLogs);
      
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
        .eq('school_id', schoolId)
        .in('id', eligibleStudentIds);
        
      // 2. Fetch Parents (prefer primary contact, fallback to any linked parent with phone)
      const { data: parentsData } = await adminClient
        .from('student_parents')
        .select('student_id, parent_id, is_primary_contact, parents(phone, full_name, school_id)')
        .in('student_id', eligibleStudentIds);

      if (studentsData && parentsData && parentsData.length > 0) {
        // Map of studentId -> { parentId, parentName, phone, is_primary_contact }
        const notificationsToSend: any[] = [];
        const studentMap = new Map(studentsData.map(s => [s.id, s.full_name]));
        
        const parentByStudent = new Map<string, any>();
        for (const sp of parentsData) {
          const phone = (sp.parents as any)?.phone;
          if (!phone) continue;
          // MULTI-TENANT: never message a guardian registered under another school.
          if ((sp.parents as any)?.school_id !== schoolId) continue;
          
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

            const smsRows: Record<string, unknown>[] = [];
            for (const notif of notificationsToSend) {
              let smsMessageText = `Dear Parent,`;
              if (attendanceType === 'check_in') {
                smsMessageText += attendanceStatus === 'late'
                  ? ` your child ${notif.studentName} checked IN LATE at school at ${timestampStr}.`
                  : ` your child ${notif.studentName} checked IN at school successfully at ${timestampStr}.`;
              } else {
                smsMessageText += ` your child ${notif.studentName} checked OUT of school and is heading home at ${timestampStr}.`;
              }

              smsRows.push({
                // One SMS per child, direction and day (double submissions can't double-charge)
                dedupe_key: attendanceSmsKey(notif.studentId, attendanceType, now),
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
            const { queued, duplicates } = await queueNotifications(adminClient, smsRows);
            console.log(`[Class Manual Attendance] Queued ${queued} SMS notifications for ${attendanceType} at ${timestampStr} EAT${duplicates ? ` (${duplicates} already queued today, skipped)` : ''}`);
          }
        }
      }
    } catch (e) {
      console.error('Failed to send class attendance SMS messages', e);
    }
  }
  
  return { success: true, count: presentLogs.length };
}
