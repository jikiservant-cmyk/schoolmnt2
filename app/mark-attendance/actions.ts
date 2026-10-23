'use server';

import { cookies, headers } from 'next/headers';
import { checkSchoolAdmin } from '@/lib/auth-guard';
import { createAdminClient } from '@/utils/supabase/admin';
import { queueNotifications, attendanceSmsKey } from '@/lib/notifications/queue';
import { isMissingColumnError, extractMissingColumn } from '@/lib/tenant';
import { isWithinAttendanceSmsWindow, getEatTodayRange, getAttendanceStatusForCheckIn } from '@/lib/attendance-window';
import {
  getSchoolSettings,
  isParentSmsEnabledForEvent,
  renderAttendanceSmsMessage,
} from '@/lib/school-settings';
import {
  KIOSK_CAPABILITY_COOKIE,
  verifyKioskCapabilityToken,
} from '@/lib/security/register-token';

async function getAuthenticatedSchoolId() {
  // 1. Verified `school_admin` session (100% preserved).
  const result = await checkSchoolAdmin();
  if (result.ok) {
    return { user: result.user, schoolId: result.schoolId, error: null };
  }

  // 2. Scoped Web-Crypto HMAC-SHA256 Gate Kiosk capability token (`?token=...` / HttpOnly cookie)
  //    so gate tablets can clock students in without holding a full `school_admin` session.
  const cookieStore = await cookies();
  let rawToken = cookieStore.get(KIOSK_CAPABILITY_COOKIE)?.value || null;
  if (!rawToken) {
    try {
      const ref = (await headers()).get('referer');
      if (ref) rawToken = new URL(ref, 'http://localhost').searchParams.get('token');
    } catch {
      rawToken = null;
    }
  }

  const verifiedKiosk = await verifyKioskCapabilityToken(rawToken);
  if (verifiedKiosk) {
    return { user: null, schoolId: verifiedKiosk.schoolId, error: null };
  }

  return {
    user: null,
    schoolId: null,
    error: result.reason === 'unauthenticated'
      ? 'Unauthorized. Please sign in to your school account.'
      : 'Access denied. School admin session required.',
  };
}

export async function submitClockInAction(deviceUserId: string) {
  if (typeof deviceUserId !== 'string' || !deviceUserId.trim()) {
    return { error: 'Please enter your Enrollment ID.' };
  }
  if (deviceUserId.length > 32 || !/^[A-Za-z0-9_-]+$/.test(deviceUserId.trim())) {
    return { error: 'Invalid Enrollment ID format.' };
  }

  const { user, schoolId, error: authError } = await getAuthenticatedSchoolId();
  if (authError || !schoolId) {
    return { error: authError || 'Unauthorized access. School context required.' };
  }

  try {
    const adminClient = createAdminClient();
    const cleanUserId = deviceUserId.trim();

    // -------------------------------------------------------------
    // Step B (Pre-query) — Resolve matching active person strictly scoped to authenticated school_id
    // -------------------------------------------------------------
    const { data: person, error: queryErr } = await adminClient
      .from('people')
      .select('id, full_name, role, school_id, class_id')
      .eq('school_id', schoolId)
      .eq('device_user_id', cleanUserId)
      .eq('is_active', true)
      .maybeSingle();

    if (queryErr) {
      console.error('Database query error on clock-in:', queryErr);
      return { error: 'Hardware database query failed.' };
    }

    let deviceId: string | null = null;
    let serialNumber = 'ZK-EMULATOR-101';
    
    const { data: dev } = await adminClient
      .from('devices')
      .select('id, serial_number')
      .eq('school_id', schoolId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (dev) {
      deviceId = dev.id;
      serialNumber = dev.serial_number;
    }

    // -------------------------------------------------------------
    // Step A — Log raw device event (audit trail) scoped to school
    // -------------------------------------------------------------
    const rawLogRow: Record<string, unknown> = {
        school_id: schoolId,
        device_id: deviceId,
        raw_serial_number: serialNumber,
        device_user_id: cleanUserId,
        event_timestamp: new Date().toISOString(),
        payload: {
          UserID: cleanUserId,
          SerialNumber: serialNumber,
          Timestamp: new Date().toISOString(),
          SimulationMode: 'terminal_emulator',
          OperatorUserId: user?.id
        },
        processed: person ? true : false,
        processed_at: person ? new Date().toISOString() : null,
        processing_error: person ? null : 'Enrollment ID not registered in this school'
      };
    let rawLog: { id: string } | null = null;
    let rawLogErr: { code?: string; message?: string } | null = null;
    const rowCandidate: Record<string, unknown> = { ...rawLogRow };
    for (let attempt = 0; attempt < 8; attempt++) {
      const ins = await adminClient
        .from('device_logs')
        .insert(rowCandidate)
        .select('id')
        .single();
      rawLog = ins.data;
      rawLogErr = ins.error;
      if (!rawLogErr) break;
      const missing = extractMissingColumn(rawLogErr);
      if (missing && Object.prototype.hasOwnProperty.call(rowCandidate, missing)) {
        delete rowCandidate[missing];
        continue;
      }
      if (isMissingColumnError(rawLogErr, 'school_id') && Object.prototype.hasOwnProperty.call(rowCandidate, 'school_id')) {
        delete rowCandidate.school_id;
        continue;
      }
      break;
    }

    if (rawLogErr) {
      console.error('Failed to write raw device log audit trail:', rawLogErr);
    }

    // If no person matches in this school, reject
    if (!person) {
      return { error: 'ID not registered for this school. Check enrollment.' };
    }

    // -------------------------------------------------------------
    // Step B2 — Check today's existing attendance logs in school timezone & apply per-school cutoffs
    // -------------------------------------------------------------
    const schoolSettings = await getSchoolSettings(adminClient, schoolId);
    const now = new Date();
    const { startIso, endIso } = getEatTodayRange(now, schoolSettings.timeZone);

    const { data: todayLogs } = await adminClient
      .from('attendance_logs')
      .select('id, attendance_type')
      .eq('person_id', person.id)
      .eq('school_id', schoolId)
      .gte('occurred_at', startIso)
      .lte('occurred_at', endIso);

    const hasCheckIn = todayLogs?.some(l => l.attendance_type === 'check_in');
    const hasCheckOut = todayLogs?.some(l => l.attendance_type === 'check_out');

    if (hasCheckIn && hasCheckOut) {
      return { error: `${person.full_name} has already checked IN and checked OUT for today.` };
    }

    let attendanceType: 'check_in' | 'check_out' = 'check_in';
    if (hasCheckIn && !hasCheckOut) {
      attendanceType = 'check_out';
    }

    const calculatedStatus = attendanceType === 'check_in'
      ? getAttendanceStatusForCheckIn(now, {
          timeZone: schoolSettings.timeZone,
          role: person.role,
          studentLateCutoff: schoolSettings.studentLateCutoff,
          studentGraceMinutes: schoolSettings.studentGraceMinutes,
          staffLateCutoff: schoolSettings.staffLateCutoff,
        })
      : 'present';

    // Resolve class name for snapshots
    let classNameAtTime: string | null = null;
    if (person.class_id) {
      const { data: cls } = await adminClient
        .from('classes')
        .select('name')
        .eq('id', person.class_id)
        .eq('school_id', schoolId)
        .maybeSingle();
      if (cls) {
        classNameAtTime = cls.name;
      }
    }

    // -------------------------------------------------------------
    // Step C — Create the attendance row with log snapshots
    // -------------------------------------------------------------
    const { data: attendanceLog, error: logErr } = await adminClient
      .from('attendance_logs')
      .insert({
        school_id: schoolId,
        person_id: person.id,
        source: 'device',
        device_id: deviceId,
        device_log_id: rawLog?.id || null,
        status: calculatedStatus,
        attendance_type: attendanceType,
        class_id_at_time: person.class_id,
        class_name_at_time: classNameAtTime,
        occurred_at: now.toISOString()
      })
      .select('id')
      .single();

    if (logErr) {
      console.error('Failed to commit attendance fact:', logErr);
      return { error: 'Transmission failed. Please try again.' };
    }

    // -------------------------------------------------------------
    // Step D — Branch by people.role (messaging/notification queuing)
    // -------------------------------------------------------------
    if (person.role === 'teacher' || person.role === 'support_staff' || person.role === 'admin') {
      return { 
        success: true, 
        fullName: person.full_name,
        role: person.role.toUpperCase(),
        msg: `Checked ${attendanceType === 'check_in' ? 'IN' : 'OUT'} successfully (Staff logs stored).`
      };
    }

    if (person.role === 'student') {
      if (!isParentSmsEnabledForEvent(schoolSettings, attendanceType, calculatedStatus)) {
        console.log(`[Manual Attendance] Attendance recorded for ${person.full_name}; parent SMS disabled by school policy.`);
      } else {
        const windowCheck = isWithinAttendanceSmsWindow(attendanceType, now, {
          timeZone: schoolSettings.timeZone,
          restrictSmsWindows: schoolSettings.restrictSmsWindows,
          checkInSmsStart: schoolSettings.checkInSmsStart,
          checkInSmsEnd: schoolSettings.checkInSmsEnd,
          checkOutSmsStart: schoolSettings.checkOutSmsStart,
          checkOutSmsEnd: schoolSettings.checkOutSmsEnd,
        });

        if (!windowCheck.allowed) {
          console.log(`[Manual Attendance] Attendance recorded for ${person.full_name}, but SMS skipped: ${windowCheck.reason}`);
        } else {
          // Retrieve the parent contact details (prefer primary contact, fallback to any linked parent)
          let studentParent: any = null;
          const { data: primaryParent } = await adminClient
            .from('student_parents')
            .select('parent_id, parents(phone, full_name, school_id)')
            .eq('student_id', person.id)
            .eq('is_primary_contact', true)
            .maybeSingle();

          if (primaryParent) {
            studentParent = primaryParent;
          } else {
            const { data: fallbackParent } = await adminClient
              .from('student_parents')
              .select('parent_id, parents(phone, full_name, school_id)')
              .eq('student_id', person.id)
              .maybeSingle();
            studentParent = fallbackParent;
          }

          // MULTI-TENANT: never message a guardian registered under another school.
          if (studentParent && (studentParent.parents as any)?.school_id !== schoolId) {
            studentParent = null;
          }

          if (studentParent && studentParent.parents) {
            const parentId = studentParent.parent_id;
            const parentPhone = (studentParent.parents as any).phone;
            
            const timestampStr = windowCheck.eatTimeStr || now.toLocaleTimeString('en-US', { 
              timeZone: schoolSettings.timeZone,
              hour: '2-digit', 
              minute: '2-digit', 
              hour12: true 
            });
            
            const smsMessageText = renderAttendanceSmsMessage(schoolSettings, attendanceType, {
              studentName: person.full_name,
              schoolName: schoolSettings.schoolName,
              time: timestampStr,
              className: classNameAtTime,
              status: calculatedStatus,
            });

            // Queue the notification in school.notifications (one per child,
            // direction and day: simultaneous taps cannot queue a second paid SMS)
            let queueErr: unknown = null;
            try {
              await queueNotifications(adminClient, [{
                dedupe_key: attendanceSmsKey(person.id, attendanceType, now, schoolSettings.timeZone),
                school_id: schoolId,
                recipient_type: 'parent',
                recipient_id: parentId,
                recipient_phone_snapshot: parentPhone,
                channel: 'sms',
                notification_type: 'attendance',
                related_table: 'attendance_logs',
                related_id: attendanceLog.id,
                message: smsMessageText,
                status: 'pending'
              }]);
            } catch (e) {
              queueErr = e;
            }

            if (queueErr) {
              console.error('Error writing outbound notification queue row:', queueErr);
            }
          } else {
            console.warn(`No primary contact guardian registered for student "${person.full_name}".`);
          }
        }
      }
    }

    return { 
      success: true, 
      fullName: person.full_name,
      role: person.role.toUpperCase()
    };
  } catch (err: any) {
    return { error: err?.message || 'Terminal processing exception.' };
  }
}

export async function getPeopleWithDeviceIds() {
  try {
    const { schoolId, error: authError } = await getAuthenticatedSchoolId();
    if (authError || !schoolId) {
      return [];
    }

    const adminClient = createAdminClient();
    const { data, error } = await adminClient
      .from('people')
      .select('full_name, role, device_user_id')
      .eq('school_id', schoolId)
      .not('device_user_id', 'is', null)
      .eq('is_active', true)
      .order('device_user_id', { ascending: true });

    if (error) {
      console.error('Error fetching people with device IDs:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('Exception fetching people with device IDs:', err);
    return [];
  }
}

