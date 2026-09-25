'use server';

import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { isWithinAttendanceSmsWindow, getEatTodayRange, getAttendanceStatusForCheckIn } from '@/lib/attendance-window';
import { createAttendanceIdentity } from '@/lib/attendance/idempotency';
import { getNextKioskAttendanceType } from '@/lib/attendance/marking';

async function getAuthenticatedSchoolId() {
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return { user: null, schoolId: null, error: 'Unauthorized. Please sign in to your school account.' };
  }

  // Try auth_school_id RPC
  try {
    const { data: rpcSchoolId } = await supabase.rpc('auth_school_id');
    if (rpcSchoolId) {
      return { user, schoolId: rpcSchoolId, error: null };
    }
  } catch (err) {
    console.warn('auth_school_id check failed in kiosk action:', err);
  }

  // Try staff_users linked via person_id -> people -> school_id
  try {
    const { data: staffData } = await supabase
      .from('staff_users')
      .select('person_id, people(school_id)')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    const peopleObj = Array.isArray(staffData?.people) ? staffData.people[0] : staffData?.people;
    const resolvedSchoolId = (peopleObj as any)?.school_id;
    if (resolvedSchoolId) {
      return { user, schoolId: resolvedSchoolId, error: null };
    }
  } catch (err) {
    console.warn('Error resolving staff_users school context:', err);
  }

  return { user, schoolId: null, error: 'No school tenant context found for this account.' };
}

export async function submitClockInAction(deviceUserId: string) {
  if (typeof deviceUserId !== 'string' || !deviceUserId.trim() || deviceUserId.trim().length > 128) {
    return { error: 'Please enter a valid Enrollment ID.' };
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
    
    const { data: dev, error: deviceErr } = await adminClient
      .from('devices')
      .select('id, serial_number')
      .eq('school_id', schoolId)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (deviceErr) {
      console.error('Failed to resolve the school kiosk device:', deviceErr);
      return { error: 'Could not verify this school\'s attendance terminal.' };
    }
    if (dev) {
      deviceId = dev.id;
      serialNumber = dev.serial_number;
    } else {
      serialNumber = 'SCHOOL-KIOSK';
    }

    // -------------------------------------------------------------
    // Step A — Log raw device event (audit trail) scoped to school
    // -------------------------------------------------------------
    const scanTime = new Date();
    const { data: rawLog, error: rawLogErr } = await adminClient
      .from('device_logs')
      .insert({
        school_id: schoolId,
        device_id: deviceId,
        raw_serial_number: serialNumber,
        device_user_id: cleanUserId,
        event_timestamp: scanTime.toISOString(),
        payload: {
          UserID: cleanUserId,
          SerialNumber: serialNumber,
          Timestamp: scanTime.toISOString(),
          SimulationMode: 'terminal_emulator',
          OperatorUserId: user?.id
        },
        processed: false,
        processed_at: null,
        processing_error: person ? null : 'Enrollment ID not registered in this school'
      })
      .select('id')
      .single();

    if (rawLogErr || !rawLog?.id) {
      console.error('Failed to write raw device log audit trail:', rawLogErr);
      return { error: 'Attendance scan could not be recorded. Please retry or contact your administrator.' };
    }

    // If no person matches in this school, reject
    if (!person) {
      return { error: 'ID not registered for this school. Check enrollment.' };
    }

    // -------------------------------------------------------------
    // Step B2 — Check today's existing attendance logs for this person in EAT
    // -------------------------------------------------------------
    const now = scanTime;
    const { startIso, endIso } = getEatTodayRange(now);

    const { data: todayLogs, error: todayLogsErr } = await adminClient
      .from('attendance_logs')
      .select('id, attendance_type')
      .eq('person_id', person.id)
      .eq('school_id', schoolId)
      .gte('occurred_at', startIso)
      .lte('occurred_at', endIso);

    if (todayLogsErr) {
      console.error('Could not check prior attendance for kiosk scan:', todayLogsErr);
      return { error: 'Could not verify today\'s attendance status. Please retry.' };
    }

    const attendanceType = getNextKioskAttendanceType(todayLogs || []);
    if (!attendanceType) {
      return { error: `${person.full_name} has already checked IN and checked OUT for today.` };
    }

    const calculatedStatus = attendanceType === 'check_in' ? getAttendanceStatusForCheckIn(now) : 'present';

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
    const attendanceIdentity = createAttendanceIdentity(schoolId, person.id, attendanceType, now);
    const { data: attendanceLog, error: logErr } = await adminClient
      .from('attendance_logs')
      .upsert({
        ...attendanceIdentity,
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
      }, {
        onConflict: 'school_id,idempotency_key',
        ignoreDuplicates: true,
      })
      .select('id')
      .maybeSingle();

    if (logErr) {
      console.error('Failed to commit attendance fact:', logErr);
      return { error: `Transmission failed: ${logErr.message}` };
    }

    const attendanceLogId = attendanceLog?.id || attendanceIdentity.id;
    const { error: processedUpdateError } = await adminClient
      .from('device_logs')
      .update({ processed: true, processed_at: new Date().toISOString(), processing_error: null })
      .eq('id', rawLog.id)
      .eq('school_id', schoolId);
    let auditWarning: string | undefined;
    if (processedUpdateError) {
      console.error('Attendance saved, but kiosk audit state could not be updated:', processedUpdateError);
      auditWarning = 'Attendance was saved, but the device audit status could not be updated.';
    }

    // -------------------------------------------------------------
    // Step D — Branch by people.role (messaging/notification queuing)
    // -------------------------------------------------------------
    if (person.role === 'teacher' || person.role === 'support_staff' || person.role === 'admin') {
      return { 
        success: true, 
        fullName: person.full_name,
        role: person.role.toUpperCase(),
        msg: `Checked ${attendanceType === 'check_in' ? 'IN' : 'OUT'} successfully (Staff logs stored).`,
        smsWarning: auditWarning,
      };
    }

    let smsWarning: string | undefined = auditWarning;
    if (person.role === 'student') {
      const windowCheck = isWithinAttendanceSmsWindow(attendanceType, now);

      if (!windowCheck.allowed) {
        console.log(`[Kiosk Attendance] Attendance recorded for ${person.full_name}, but SMS skipped: ${windowCheck.reason}`);
      } else {
        // Only queue a guardian contact if the related parent record belongs to
        // this same school. A corrupt student_parents link must not cross tenants.
        const { data: parentLinks, error: parentErr } = await adminClient
          .from('student_parents')
          .select('parent_id, is_primary_contact, parents(phone, full_name, school_id)')
          .eq('student_id', person.id)
          .order('is_primary_contact', { ascending: false });

        if (parentErr) {
          console.error('Could not resolve guardian for kiosk SMS:', parentErr);
          smsWarning = 'Attendance was saved, but the SMS recipient could not be verified.';
        } else {
          const parentLink = (parentLinks || []).find(link => {
            const related = Array.isArray(link.parents) ? link.parents[0] : link.parents;
            return related?.school_id === schoolId && !!related?.phone;
          });
          const parent = parentLink
            ? (Array.isArray(parentLink.parents) ? parentLink.parents[0] : parentLink.parents) as any
            : null;

          if (parentLink && parent?.phone) {
            const timestampStr = windowCheck.eatTimeStr || now.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true
            });
            const smsMessageText = attendanceType === 'check_in'
              ? `Dear Parent, your child ${person.full_name} checked in successfully at ${timestampStr}.`
              : `Dear Parent, your child ${person.full_name} checked OUT of school successfully at ${timestampStr}.`;

            const { error: queueErr } = await adminClient
              .from('notifications')
              .upsert({
                school_id: schoolId,
                recipient_type: 'parent',
                recipient_id: parentLink.parent_id,
                recipient_phone_snapshot: parent.phone,
                channel: 'sms',
                notification_type: 'attendance',
                related_table: 'attendance_logs',
                related_id: attendanceLogId,
                message: smsMessageText,
                status: 'pending'
              }, {
                onConflict: 'school_id,notification_type,related_id,channel',
                ignoreDuplicates: true,
              });

            if (queueErr) {
              console.error('Error writing outbound notification queue row:', queueErr);
              smsWarning = 'Attendance was saved, but its SMS could not be queued.';
            }
          } else {
            console.warn(`No same-school guardian contact is registered for student "${person.full_name}".`);
            smsWarning = 'Attendance was saved, but no verified same-school guardian contact is registered.';
          }
        }
      }
    }

    return {
      success: true,
      fullName: person.full_name,
      role: person.role.toUpperCase(),
      smsWarning
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

