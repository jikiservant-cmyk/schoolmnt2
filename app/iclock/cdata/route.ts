import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { isWithinAttendanceSmsWindow } from '@/lib/attendance-window';

// Helper to authenticate ZKTeco terminal
async function authenticateDevice(req: NextRequest, sn: string | null) {
  if (!sn || !sn.trim()) {
    return { authenticated: false, reason: 'Missing device serial number (SN)' };
  }

  const cleanSn = sn.trim().toUpperCase();
  const supabase = createAdminClient();

  const { data: device, error } = await supabase
    .from('devices')
    .select('id, school_id, is_active, label')
    .ilike('serial_number', cleanSn)
    .maybeSingle();

  if (error || !device) {
    return { authenticated: false, reason: `Unregistered device serial number: ${cleanSn}` };
  }

  if (!device.is_active) {
    return { authenticated: false, reason: `Device ${cleanSn} is deactivated in portal` };
  }

  // Check optional device token / secret if configured in environment
  const expectedSecret = process.env.ZKTECO_DEVICE_SECRET;
  if (expectedSecret) {
    const { searchParams } = new URL(req.url);
    const providedToken = 
      req.headers.get('x-device-token') || 
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || 
      searchParams.get('token') || 
      searchParams.get('push_token') || 
      searchParams.get('PushToken');

    if (!providedToken || providedToken !== expectedSecret) {
      return { authenticated: false, reason: 'Invalid or missing device authentication token' };
    }
  }

  return { authenticated: true, device, supabase };
}

// 1. Initial Handshake / Config Pull from Device
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN');
  
  console.log(`[ZKTeco ADMS] Init GET request from SN: ${sn}`);

  const authResult = await authenticateDevice(req, sn);
  if (!authResult.authenticated || !authResult.device) {
    console.warn(`[ZKTeco ADMS] Rejected GET from unrecognized device: ${sn}. Reason: ${authResult.reason}`);
    return new NextResponse(`ERROR: ${authResult.reason}`, {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // Update device heartbeat
  await authResult.supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', authResult.device.id);

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

  const authResult = await authenticateDevice(req, sn);
  if (!authResult.authenticated || !authResult.device) {
    console.warn(`[ZKTeco ADMS] Rejected POST from device: ${sn}. Reason: ${authResult.reason}`);
    return new NextResponse(`ERROR: ${authResult.reason}`, {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const { device, supabase } = authResult;
  const rawBody = await req.text();
  console.log(`[ZKTeco ADMS] POST request from SN: ${sn}, Table: ${table}`);

  // Update heartbeat on data push
  await supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id);

  // If this is an attendance log push (table=ATTLOG or attlog or body contains attendance records)
  const isAttLog = table === 'ATTLOG' || table === 'OPERLOG' || rawBody.includes('\t20') || /^\S+\s+\d{4}-\d{2}-\d{2}/m.test(rawBody);

  if (isAttLog) {
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

      // Timestamp sanity validation (reject clock drifts > 24 hours in future or > 60 days in past)
      let logDate: Date;
      let isoString: string;
      try {
        if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(datetimeStr.trim())) {
          isoString = new Date(datetimeStr.trim().replace(' ', 'T') + '+03:00').toISOString();
          logDate = new Date(isoString);
        } else {
          logDate = new Date(datetimeStr);
          isoString = logDate.toISOString();
        }
      } catch (e) {
        console.warn(`[ZKTeco ADMS] Invalid timestamp format "${datetimeStr}", using server time.`);
        logDate = new Date();
        isoString = logDate.toISOString();
      }

      const nowTime = Date.now();
      const timeDiff = Math.abs(logDate.getTime() - nowTime);
      const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
      if (timeDiff > sixtyDaysMs) {
        console.warn(`[ZKTeco ADMS] Discarding attendance entry with stale/invalid timestamp: ${datetimeStr} (PIN: ${cleanPin})`);
        continue;
      }

      // Find user (teacher, student, staff, admin) strictly mapped to device.school_id
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

      // 3. Fallback: Search all enrolled people strictly in this device's school
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

          // Insert into school.attendance_logs
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
