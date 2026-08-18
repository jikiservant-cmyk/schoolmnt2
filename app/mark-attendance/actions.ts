'use server';

import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { isWithinAttendanceSmsWindow, getEatTodayRange, getAttendanceStatusForCheckIn } from '@/lib/attendance-window';

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
  if (!deviceUserId) {
    return { error: 'Please enter your Enrollment ID.' };
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
    const { data: rawLog, error: rawLogErr } = await adminClient
      .from('device_logs')
      .insert({
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
      })
      .select('id')
      .single();

    if (rawLogErr) {
      console.error('Failed to write raw device log audit trail:', rawLogErr);
    }

    // If no person matches in this school, reject
    if (!person) {
      return { error: 'ID not registered for this school. Check enrollment.' };
    }

    // -------------------------------------------------------------
    // Step B2 — Check today's existing attendance logs for this person in EAT
    // -------------------------------------------------------------
    const now = new Date();
    const { startIso, endIso } = getEatTodayRange(now);

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
      return { error: `Transmission failed: ${logErr.message}` };
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
      const windowCheck = isWithinAttendanceSmsWindow(attendanceType, now);

      if (!windowCheck.allowed) {
        console.log(`[Manual Attendance] Attendance recorded for ${person.full_name}, but SMS skipped: ${windowCheck.reason}`);
      } else {
        // Retrieve the parent contact details (prefer primary contact, fallback to any linked parent)
        let studentParent: any = null;
        const { data: primaryParent } = await adminClient
          .from('student_parents')
          .select('parent_id, parents(phone, full_name)')
          .eq('student_id', person.id)
          .eq('is_primary_contact', true)
          .maybeSingle();

        if (primaryParent) {
          studentParent = primaryParent;
        } else {
          const { data: fallbackParent } = await adminClient
            .from('student_parents')
            .select('parent_id, parents(phone, full_name)')
            .eq('student_id', person.id)
            .maybeSingle();
          studentParent = fallbackParent;
        }

        if (studentParent && studentParent.parents) {
          const parentId = studentParent.parent_id;
          const parentPhone = (studentParent.parents as any).phone;
          
          const timestampStr = windowCheck.eatTimeStr || now.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit', 
            hour12: true 
          });
          
          const smsMessageText = attendanceType === 'check_in'
            ? `Dear Parent, your child ${person.full_name} checked in successfully at ${timestampStr}.`
            : `Dear Parent, your child ${person.full_name} checked OUT of school successfully at ${timestampStr}.`;

          // Queue the notification in school.notifications
          const { error: queueErr } = await adminClient
            .from('notifications')
            .insert({
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
            });

          if (queueErr) {
            console.error('Error writing outbound notification queue row:', queueErr);
          }
        } else {
          console.warn(`No primary contact guardian registered for student "${person.full_name}".`);
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

