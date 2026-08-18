'use server';

import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { isWithinAttendanceSmsWindow, getEatTodayRange, getAttendanceStatusForCheckIn } from '@/lib/attendance-window';

export async function submitClockInAction(deviceUserId: string) {
  if (!deviceUserId) {
    return { error: 'Please enter your Enrollment ID.' };
  }

  try {
    // We use a public admin client to bypass RLS policies during public clock-in device simulation
    const adminClient = createPublicAdminClient();
    const cleanUserId = deviceUserId.trim();

    // -------------------------------------------------------------
    // Step B (Pre-query) — Resolve matching active person
    // -------------------------------------------------------------
    const { data: person, error: queryErr } = await adminClient
      .from('people')
      .select('id, full_name, role, school_id, class_id')
      .eq('device_user_id', cleanUserId)
      .eq('is_active', true)
      .maybeSingle();

    if (queryErr) {
      console.error('Database query error on clock-in:', queryErr);
      return { error: 'Hardware database query failed.' };
    }

    // Resolve school and device contexts for logging
    let schoolId = person?.school_id || null;
    if (!schoolId) {
      // Find a default fallback school just to log the raw device event if the directory check failed
      const { data: anySchool } = await adminClient
        .from('schools')
        .select('id')
        .limit(1)
        .maybeSingle();
      schoolId = anySchool?.id || null;
    }

    let deviceId: string | null = null;
    let serialNumber = 'ZK-EMULATOR-101';
    if (schoolId) {
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
    }

    // -------------------------------------------------------------
    // Step A — Log raw device event (audit trail) first
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
          SimulationMode: 'terminal_emulator'
        },
        processed: person ? true : false,
        processed_at: person ? new Date().toISOString() : null,
        processing_error: person ? null : 'Enrollment ID not registered in people directory'
      })
      .select('id')
      .single();

    if (rawLogErr) {
      console.error('Failed to write raw device log audit trail:', rawLogErr);
    }

    // If no person matches, we do not proceed with creating attendance rows or alerts
    if (!person) {
      return { error: 'ID not registered. Check enrollment.' };
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
        school_id: person.school_id,
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
    if (person.role === 'teacher') {
      // Teachers end here; no guardian SMS is queued
      return { 
        success: true, 
        fullName: person.full_name,
        role: person.role.toUpperCase(),
        msg: `Checked ${attendanceType === 'check_in' ? 'IN' : 'OUT'} successfully (Faculty logs stored).`
      };
    }

    if (person.role === 'student') {
      const windowCheck = isWithinAttendanceSmsWindow(attendanceType, now);

      if (!windowCheck.allowed) {
        console.log(`[Manual Attendance] Attendance recorded for ${person.full_name}, but SMS skipped: ${windowCheck.reason}`);
      } else {
        // Retrieve the parent contact details (prefer primary contact, fallback to any linked parent)
        let studentParent: any = null;
        const { data: primaryParent, error: parentErr } = await adminClient
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
          const parentName = (studentParent.parents as any).full_name;
          
          const timestampStr = windowCheck.eatTimeStr || now.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit', 
            hour12: true 
          });
          
          const smsMessageText = attendanceType === 'check_in'
            ? `Dear Parent, your child ${person.full_name} checked in successfully at ${timestampStr}.`
            : `Dear Parent, your child ${person.full_name} checked OUT of school successfully at ${timestampStr}.`;
          const smsReference = `ATT-${attendanceLog.id}-${Date.now()}`;

          // Queue the notification in school.notifications
          // The Supabase Edge Function will handle wallet deduction and Najiki dispatch
          const { error: queueErr } = await adminClient
            .from('notifications')
            .insert({
              school_id: person.school_id,
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
    const adminClient = createPublicAdminClient();
    const { data, error } = await adminClient
      .from('people')
      .select('full_name, role, device_user_id')
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

