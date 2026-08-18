import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { isWithinAttendanceSmsWindow } from '@/lib/attendance-window';

// 1. Initial Handshake / Config Pull from Device
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN');
  
  console.log(`[ZKTeco ADMS] Init GET request from SN: ${sn}`);
  console.log(`[ZKTeco ADMS] Query Params:`, Object.fromEntries(searchParams.entries()));

  if (sn) {
    const supabase = createAdminClient();
    // Verify device exists in our registry and update heartbeat
    const { data: device } = await supabase
      .from('devices')
      .select('id')
      .eq('serial_number', sn)
      .maybeSingle();
      
    if (device) {
      await supabase
        .from('devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', device.id);
    } else {
      console.warn(`[ZKTeco ADMS] Unrecognized device SN: ${sn}. Please add it to the portal.`);
    }
  }

  // The device expects a specific text configuration response to know the server is ready.
  // Standard ADMS parameters for F18 and similar legacy devices.
  const responseText = `GET OPTION FROM: ${sn}\nStamp=9999\nOpStamp=9999\nErrorDelay=60\nDelay=10\nTransTimes=00:00;14:00\nTransInterval=1\nTransFlag=1111000000\nTimeZone=180\nRealtime=1\nEncrypt=0`;
  
  return new NextResponse(responseText, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}

// 2. Data Push (Attendance Logs, Users, etc.)
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN') || searchParams.get('sn') || req.headers.get('x-device-sn') || '';
  const table = (searchParams.get('table') || searchParams.get('TABLE') || '').toUpperCase();

  const rawBody = await req.text();
  console.log(`[ZKTeco ADMS] POST request from SN: ${sn}, Table: ${table}`);
  console.log(`[ZKTeco ADMS] Payload:\n${rawBody}`);

  const supabase = createAdminClient();

  let device: { id: string; school_id: string } | null = null;

  if (sn) {
    const { data } = await supabase
      .from('devices')
      .select('id, school_id')
      .ilike('serial_number', sn.trim())
      .maybeSingle();
     
    device = data as any;

    if (device) {
      await supabase
        .from('devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', device.id);
    }
  }

  // If this is an attendance log push (table=ATTLOG or attlog or body contains attendance records)
  const isAttLog = table === 'ATTLOG' || table === 'OPERLOG' || rawBody.includes('\t20') || /^\S+\s+\d{4}-\d{2}-\d{2}/m.test(rawBody);

  if (isAttLog && sn) {
    if (!device) {
      console.warn(`[ZKTeco ADMS] Received ATTLOG for unknown device SN: ${sn}`);
      // Acknowledge anyway so the device doesn't hang/infinitely retry
      return new NextResponse('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    // Split lines from raw payload
    const lines = rawBody.split(/[\r\n]+/).map(line => line.trim()).filter(line => line.length > 0);
    
    for (const line of lines) {
      // Parse line tokens: PIN, Date_Time, Status, Verify_Type, Work_Code
      let pin = '';
      let datetimeStr = '';
      let statusNum = '0';
      let verifyType = '1';

      if (line.includes('\t')) {
        const parts = line.split('\t').map(s => s.trim());
        pin = parts[0];
        datetimeStr = parts[1];
        statusNum = parts[2] || '0';
        verifyType = parts[3] || '1';
      } else if (line.includes(',')) {
        const parts = line.split(',').map(s => s.trim());
        pin = parts[0];
        datetimeStr = parts[1];
        statusNum = parts[2] || '0';
        verifyType = parts[3] || '1';
      } else {
        const match = line.match(/^(\S+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:\s+(\d+))?(?:\s+(\d+))?/);
        if (match) {
          pin = match[1];
          datetimeStr = match[2];
          statusNum = match[3] || '0';
          verifyType = match[4] || '1';
        } else {
          const parts = line.split(/\s+/);
          if (parts.length >= 3) {
            pin = parts[0];
            datetimeStr = `${parts[1]} ${parts[2]}`;
            statusNum = parts[3] || '0';
          }
        }
      }

      if (!pin || !datetimeStr) {
        continue;
      }

      const cleanPin = pin.trim();
      const numericPin = cleanPin.replace(/^0+/, ''); // e.g. '00101' -> '101'
      const paddedPin4 = cleanPin.padStart(4, '0');

      // Find user (teacher, student, staff, admin) by device_user_id mapped to this specific school
      let person: any = null;

      // 1. Exact match
      const { data: pExact } = await supabase
        .from('people')
        .select('id, full_name, role, class_id, is_active, classes:class_id(id, name)')
        .eq('school_id', device.school_id)
        .eq('device_user_id', cleanPin)
        .maybeSingle();

      if (pExact) {
        person = pExact;
      } else if (numericPin && numericPin !== cleanPin) {
        // 2. Numeric match (stripped leading zeroes)
        const { data: pNum } = await supabase
          .from('people')
          .select('id, full_name, role, class_id, is_active, classes:class_id(id, name)')
          .eq('school_id', device.school_id)
          .eq('device_user_id', numericPin)
          .maybeSingle();
        if (pNum) person = pNum;
      }

      // 3. Fallback: Search all enrolled people in school
      if (!person) {
        const { data: pAll } = await supabase
          .from('people')
          .select('id, full_name, role, class_id, is_active, device_user_id, classes:class_id(id, name)')
          .eq('school_id', device.school_id)
          .not('device_user_id', 'is', null);

        if (pAll && pAll.length > 0) {
          const matched = pAll.find((p: any) => {
            const pUid = (p.device_user_id || '').trim();
            if (!pUid) return false;
            const pNum = pUid.replace(/^0+/, '');
            return (
              pUid.toLowerCase() === cleanPin.toLowerCase() ||
              pNum === numericPin ||
              pUid === paddedPin4 ||
              cleanPin === pUid.padStart(4, '0')
            );
          });
          if (matched) {
            person = matched;
          }
        }
      }
          
      if (person) {
        let isoString: string;
        let logDate: Date;
        try {
          // If datetimeStr is 'YYYY-MM-DD HH:MM:SS', treat as Africa/Kampala time (+03:00)
          if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(datetimeStr.trim())) {
            isoString = new Date(datetimeStr.trim().replace(' ', 'T') + '+03:00').toISOString();
            logDate = new Date(isoString);
          } else {
            logDate = new Date(datetimeStr);
            isoString = logDate.toISOString();
          }
        } catch (e) {
          logDate = new Date();
          isoString = logDate.toISOString();
        }

        // Check for duplicates (same person, same ISO timestamp)
        const { data: existingLog } = await supabase
          .from('attendance_logs')
          .select('id')
          .eq('person_id', person.id)
          .eq('occurred_at', isoString)
          .maybeSingle();
             
        if (!existingLog) {
          const attendanceType: 'check_in' | 'check_out' = statusNum === '0' ? 'check_in' : (statusNum === '1' ? 'check_out' : 'check_in');

          // Calculate local hour/minute in Africa/Kampala for accurate punctuality
          const kampalaFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Africa/Kampala',
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
          });
          const timeParts = kampalaFormatter.formatToParts(logDate);
          const localHour = parseInt(timeParts.find(p => p.type === 'hour')?.value || '0', 10);
          const localMinute = parseInt(timeParts.find(p => p.type === 'minute')?.value || '0', 10);
          const isLate = (localHour > 8) || (localHour === 8 && localMinute > 0);
          const status = attendanceType === 'check_in' ? (isLate ? 'late' : 'present') : 'present';

          // Insert raw audit entry into school.device_logs
          let deviceLogId: string | null = null;
          try {
            const { data: devLog } = await supabase
              .from('device_logs')
              .insert({
                device_id: device.id,
                raw_serial_number: sn,
                device_user_id: cleanPin,
                event_timestamp: isoString,
                payload: {
                  raw_line: line,
                  pin: cleanPin,
                  role: person.role,
                  full_name: person.full_name,
                  status_num: statusNum,
                  verify_type: verifyType
                },
                processed: true,
                processed_at: new Date().toISOString()
              })
              .select('id')
              .maybeSingle();
            if (devLog?.id) deviceLogId = devLog.id;
          } catch (dlErr) {
            console.warn('[ZKTeco ADMS] Device log audit insert note:', dlErr);
          }

          // Insert into school.attendance_logs (Supports teachers, students, admins)
          const { error: insErr } = await supabase
            .from('attendance_logs')
            .insert({
              school_id: device.school_id,
              person_id: person.id,
              source: 'device',
              device_id: device.id,
              device_log_id: deviceLogId,
              status: status,
              attendance_type: attendanceType,
              occurred_at: isoString,
              marked_by: null,
              class_id_at_time: person.class_id || null,
              class_name_at_time: person.classes?.name || (person.role === 'teacher' ? 'Faculty Member' : null)
            });

          if (insErr) {
            console.error(`[ZKTeco ADMS] Failed to record attendance for ${person.role} ${person.full_name}:`, insErr);
          } else {
            console.log(`[ZKTeco ADMS] Successfully recorded attendance row for ${person.role} "${person.full_name}" (PIN: ${cleanPin}, Status: ${status})`);
          }

          // If this is a student, check if within allowed EAT SMS dispatch window
          if (person.role === 'student') {
            const windowCheck = isWithinAttendanceSmsWindow(attendanceType, logDate);

            if (!windowCheck.allowed) {
              console.log(`[ZKTeco ADMS] Attendance recorded for student ${person.full_name}, but SMS skipped: ${windowCheck.reason}`);
            } else {
              const { data: studentParent } = await supabase
                .from('student_parents')
                .select('parent_id, parents(phone)')
                .eq('student_id', person.id)
                .eq('is_primary_contact', true)
                .maybeSingle();
                 
              const parentObj = Array.isArray(studentParent?.parents) 
                ? (studentParent.parents[0] as any) 
                : (studentParent?.parents as any);
                 
              if (parentObj?.phone) {
                const timeFormatted = windowCheck.eatTimeStr || logDate.toLocaleTimeString([], { timeZone: 'Africa/Kampala', hour: '2-digit', minute: '2-digit' });
                const actionText = attendanceType === 'check_in' ? 'arrived safely at school' : 'clocked out from school';
                const smsMessageText = `${person.full_name} has ${actionText} at ${timeFormatted}.`;

                await supabase.from('notifications').insert({
                  school_id: device.school_id,
                  recipient_type: 'parent',
                  recipient_id: studentParent!.parent_id,
                  recipient_phone_snapshot: parentObj.phone,
                  channel: 'sms',
                  notification_type: 'attendance',
                  status: 'pending',
                  message: smsMessageText
                });
                console.log(`[ZKTeco ADMS] Queued SMS notification for student ${person.full_name} (${attendanceType} at ${timeFormatted} EAT)`);
              }
            }
          }
        } else {
          console.log(`[ZKTeco ADMS] Duplicate attendance skipped for ${person.role} "${person.full_name}" (PIN ${cleanPin}) at ${datetimeStr}`);
        }
      } else {
        console.warn(`[ZKTeco ADMS] Unrecognized PIN "${cleanPin}" for school ${device.school_id}. Please ensure this PIN is assigned to a student or teacher in the People directory.`);
      }
    }
  }

  // Acknowledge receipt to clear the transactions from the device queue
  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
