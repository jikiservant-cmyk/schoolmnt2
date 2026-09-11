const fs = require('fs');

const path = 'app/iclock/cdata/route.ts';
let content = fs.readFileSync(path, 'utf8');

const replacement = `// 2. Data Push (Attendance Logs, Users, etc.)
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN') || searchParams.get('sn') || req.headers.get('x-device-sn') || '';
  const table = (searchParams.get('table') || searchParams.get('TABLE') || '').toUpperCase();

  const authResult = await authenticateDevice(req, sn);
  if (!authResult.authenticated || !authResult.device) {
    console.warn(\`[ZKTeco ADMS] Rejected POST from device: \${sn}. Reason: \${authResult.reason}\`);
    return new NextResponse(\`ERROR: \${authResult.reason}\`, {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const { device, supabase } = authResult;
  const rawBody = await req.text();
  console.log(\`[ZKTeco ADMS] POST request from SN: \${sn}, Table: \${table}\`);

  // Update heartbeat on data push (fire and forget)
  supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id)
    .then();

  // If this is an attendance log push
  const isAttLog = table === 'ATTLOG' || table === 'OPERLOG' || rawBody.includes('\\t20') || /^\\S+\\s+\\d{4}-\\d{2}-\\d{2}/m.test(rawBody);

  if (isAttLog) {
    const lines = rawBody.split(/[\\r\\n]+/).map(line => line.trim()).filter(line => line.length > 0);
    if (lines.length > 0) {
      // 1. Fetch all people in this school that have a device_user_id
      const { data: peopleData } = await supabase
        .from('people')
        .select('id, full_name, role, class_id, is_active, device_user_id, classes:class_id(id, name)')
        .eq('school_id', device.school_id)
        .not('device_user_id', 'is', null);

      const people = peopleData || [];
      const personMap = new Map();
      // Map for exact device_user_id, and padded versions
      for (const p of people) {
        const pUid = (p.device_user_id || '').trim().toLowerCase();
        if (!pUid) continue;
        const pNum = pUid.replace(/^0+/, '');
        const pPadded = pUid.padStart(4, '0');
        
        if (!personMap.has(pUid)) personMap.set(pUid, p);
        if (!personMap.has(pNum)) personMap.set(pNum, p);
        if (!personMap.has(pPadded)) personMap.set(pPadded, p);
      }

      // 2. Parse lines and gather parsed records
      const parsedRecords = [];
      const earliestDate = new Date();
      const latestDate = new Date('2000-01-01');

      for (const line of lines) {
        let pin = '';
        let datetimeStr = '';
        let statusNum = '0';
        let verifyType = '1';

        if (line.includes('\\t')) {
          const parts = line.split('\\t').map(s => s.trim());
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
          const match = line.match(/^(\\S+)\\s+(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2})(?:\\s+(\\d+))?(?:\\s+(\\d+))?/);
          if (match) {
            pin = match[1];
            datetimeStr = match[2];
            statusNum = match[3] || '0';
            verifyType = match[4] || '1';
          } else {
            const parts = line.split(/\\s+/);
            if (parts.length >= 3) {
              pin = parts[0];
              datetimeStr = \`\${parts[1]} \${parts[2]}\`;
              statusNum = parts[3] || '0';
            }
          }
        }

        if (!pin || !datetimeStr) continue;

        const cleanPin = pin.trim().toLowerCase();
        
        let logDate;
        let isoString;
        try {
          if (/^\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}(:\\d{2})?$/.test(datetimeStr.trim())) {
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

        const nowTime = Date.now();
        const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
        if (Math.abs(logDate.getTime() - nowTime) > sixtyDaysMs) continue;
        
        const person = personMap.get(cleanPin) || personMap.get(cleanPin.replace(/^0+/, '')) || personMap.get(cleanPin.padStart(4, '0'));
        if (!person) {
          console.warn(\`[ZKTeco ADMS] Unrecognized PIN "\${cleanPin}" for school \${device.school_id}.\`);
          continue;
        }

        if (logDate < earliestDate) earliestDate.setTime(logDate.getTime());
        if (logDate > latestDate) latestDate.setTime(logDate.getTime());

        parsedRecords.push({ line, pin: cleanPin, statusNum, verifyType, logDate, isoString, person });
      }

      if (parsedRecords.length > 0) {
        // 3. Fetch existing attendance logs in date range to prevent duplicates
        const earliestIso = new Date(earliestDate.getTime() - 1000).toISOString();
        const latestIso = new Date(latestDate.getTime() + 1000).toISOString();
        const personIds = Array.from(new Set(parsedRecords.map(r => r.person.id)));

        const { data: existingLogs } = await supabase
          .from('attendance_logs')
          .select('person_id, occurred_at')
          .eq('school_id', device.school_id)
          .in('person_id', personIds)
          .gte('occurred_at', earliestIso)
          .lte('occurred_at', latestIso);

        const existingSet = new Set((existingLogs || []).map(l => \`\${l.person_id}-\${l.occurred_at}\`));

        const deviceLogsToInsert = [];
        const attendanceLogsToInsert = [];
        const validStudentRecords = [];
        const nowIso = new Date().toISOString();

        for (const record of parsedRecords) {
          if (existingSet.has(\`\${record.person.id}-\${record.isoString}\`)) continue;

          // Prevent inserting duplicates in this very batch
          existingSet.add(\`\${record.person.id}-\${record.isoString}\`);

          const deviceLogId = crypto.randomUUID();
          
          deviceLogsToInsert.push({
            id: deviceLogId,
            device_id: device.id,
            raw_serial_number: sn,
            device_user_id: record.pin,
            event_timestamp: record.isoString,
            payload: {
              raw_line: record.line,
              pin: record.pin,
              role: record.person.role,
              full_name: record.person.full_name,
              status_num: record.statusNum,
              verify_type: record.verifyType
            },
            processed: true,
            processed_at: nowIso
          });

          const attendanceType = record.statusNum === '0' ? 'check_in' : (record.statusNum === '1' ? 'check_out' : 'check_in');

          const kampalaFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Africa/Kampala',
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
          });
          const timeParts = kampalaFormatter.formatToParts(record.logDate);
          const localHour = parseInt(timeParts.find(p => p.type === 'hour')?.value || '0', 10);
          const localMinute = parseInt(timeParts.find(p => p.type === 'minute')?.value || '0', 10);
          const isLate = (localHour > 8) || (localHour === 8 && localMinute > 0);
          const status = attendanceType === 'check_in' ? (isLate ? 'late' : 'present') : 'present';

          attendanceLogsToInsert.push({
            school_id: device.school_id,
            person_id: record.person.id,
            source: 'device',
            device_id: device.id,
            device_log_id: deviceLogId,
            status: status,
            attendance_type: attendanceType,
            occurred_at: record.isoString,
            marked_by: null,
            class_id_at_time: record.person.class_id || null,
            class_name_at_time: record.person.classes?.name || (record.person.role === 'teacher' ? 'Faculty Member' : null)
          });

          if (record.person.role === 'student') {
            const windowCheck = isWithinAttendanceSmsWindow(attendanceType, record.logDate);
            if (windowCheck.allowed) {
              validStudentRecords.push({ ...record, attendanceType, status, timeFormatted: windowCheck.eatTimeStr });
            }
          }
        }

        if (deviceLogsToInsert.length > 0) {
          await supabase.from('device_logs').insert(deviceLogsToInsert);
        }
        if (attendanceLogsToInsert.length > 0) {
          await supabase.from('attendance_logs').insert(attendanceLogsToInsert);
          console.log(\`[ZKTeco ADMS] Batch inserted \${attendanceLogsToInsert.length} attendance logs\`);
        }

        if (validStudentRecords.length > 0) {
          const sIds = Array.from(new Set(validStudentRecords.map(r => r.person.id)));
          const { data: parentsData } = await supabase
            .from('student_parents')
            .select('student_id, parent_id, parents(phone)')
            .in('student_id', sIds)
            .eq('is_primary_contact', true);

          const parentMap = new Map();
          if (parentsData) {
            for (const row of parentsData) {
              parentMap.set(row.student_id, {
                parent_id: row.parent_id,
                phone: Array.isArray(row.parents) ? row.parents[0]?.phone : row.parents?.phone
              });
            }
          }

          const notificationsToInsert = [];
          for (const record of validStudentRecords) {
            const pInfo = parentMap.get(record.person.id);
            if (pInfo && pInfo.phone) {
              const actionText = record.attendanceType === 'check_in' ? 'arrived safely at school' : 'clocked out from school';
              const timeFormatted = record.timeFormatted || record.logDate.toLocaleTimeString([], { timeZone: 'Africa/Kampala', hour: '2-digit', minute: '2-digit' });
              
              notificationsToInsert.push({
                school_id: device.school_id,
                recipient_type: 'parent',
                recipient_id: pInfo.parent_id,
                recipient_phone_snapshot: pInfo.phone,
                channel: 'sms',
                notification_type: 'attendance',
                status: 'pending',
                message: \`\${record.person.full_name} has \${actionText} at \${timeFormatted}.\`
              });
            }
          }

          if (notificationsToInsert.length > 0) {
            await supabase.from('notifications').insert(notificationsToInsert);
            console.log(\`[ZKTeco ADMS] Queued \${notificationsToInsert.length} SMS notifications\`);
          }
        }
      }
    }
  }

  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
`;

content = content.replace(/\/\/ 2\. Data Push \(Attendance Logs, Users, etc\.\)[\s\S]+$/, replacement);
fs.writeFileSync(path, content);
