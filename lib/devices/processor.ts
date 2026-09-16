import { AttendanceEvent, DeviceRecord } from './types';
import { createAdminClient } from '@/utils/supabase/admin';
import { isWithinAttendanceSmsWindow } from '@/lib/attendance-window';

export interface ProcessEventsResult {
  totalReceived: number;
  matchedCount: number;
  unrecognizedCount: number;
  insertedAttendanceLogs: number;
  insertedDeviceLogs: number;
  queuedSmsCount: number;
  skippedDuplicates: number;
}

/**
 * High-performance normalized attendance event processor for all device vendors.
 * Handles person lookup, deduplication, late-cutoff calculation, batch inserts, and SMS queues.
 */
export async function processAttendanceEvents(
  events: AttendanceEvent[],
  device: DeviceRecord
): Promise<ProcessEventsResult> {
  const result: ProcessEventsResult = {
    totalReceived: events.length,
    matchedCount: 0,
    unrecognizedCount: 0,
    insertedAttendanceLogs: 0,
    insertedDeviceLogs: 0,
    queuedSmsCount: 0,
    skippedDuplicates: 0
  };

  if (!events || events.length === 0) {
    return result;
  }

  const supabase = createAdminClient();

  // 1. Fetch all people in this school that have a device_user_id
  const { data: peopleData, error: peopleErr } = await supabase
    .from('people')
    .select('id, full_name, role, class_id, is_active, device_user_id, classes:class_id(id, name)')
    .eq('school_id', device.school_id)
    .not('device_user_id', 'is', null);

  if (peopleErr) {
    console.error(`[Device Processor] Failed to load people for school ${device.school_id}:`, peopleErr);
    return result;
  }

  const people = peopleData || [];
  const personMap = new Map<string, any>();
  for (const p of people) {
    const pUid = (p.device_user_id || '').trim().toLowerCase();
    if (!pUid) continue;
    const pNum = pUid.replace(/^0+/, '');
    const pPadded = pUid.padStart(4, '0');

    if (!personMap.has(pUid)) personMap.set(pUid, p);
    if (!personMap.has(pNum)) personMap.set(pNum, p);
    if (!personMap.has(pPadded)) personMap.set(pPadded, p);
  }

  // Also resolve from school.person_credentials (multi-vendor credentials)
  try {
    const { data: credsData } = await supabase
      .from('person_credentials')
      .select('identifier_value, person:person_id(id, full_name, role, class_id, is_active, device_user_id, classes:class_id(id, name))')
      .eq('school_id', device.school_id)
      .eq('is_active', true);

    if (credsData) {
      for (const c of credsData) {
        if (!c.identifier_value || !c.person) continue;
        const pObj = Array.isArray(c.person) ? c.person[0] : c.person;
        if (!pObj) continue;

        const cVal = c.identifier_value.trim().toLowerCase();
        const cNum = cVal.replace(/^0+/, '');
        const cPadded = cVal.padStart(4, '0');

        if (!personMap.has(cVal)) personMap.set(cVal, pObj);
        if (!personMap.has(cNum)) personMap.set(cNum, pObj);
        if (!personMap.has(cPadded)) personMap.set(cPadded, pObj);
      }
    }
  } catch (credErr) {
    // Non-blocking fallback if person_credentials query fails
  }

  // 2. Filter and match events
  const matchedList: {
    event: AttendanceEvent;
    person: any;
    isoString: string;
    logDate: Date;
  }[] = [];

  let earliestDate = new Date();
  let latestDate = new Date('2000-01-01');

  for (const ev of events) {
    const cleanPin = ev.person_external_id.trim().toLowerCase();
    const person = personMap.get(cleanPin) || 
                   personMap.get(cleanPin.replace(/^0+/, '')) || 
                   personMap.get(cleanPin.padStart(4, '0'));

    if (!person) {
      console.warn(`[Device Processor] Unrecognized external ID "${cleanPin}" on device ${device.serial_number}`);
      result.unrecognizedCount++;
      continue;
    }

    result.matchedCount++;
    const logDate = ev.timestamp instanceof Date && !isNaN(ev.timestamp.getTime()) ? ev.timestamp : new Date();
    const isoString = logDate.toISOString();

    if (logDate < earliestDate) earliestDate = logDate;
    if (logDate > latestDate) latestDate = logDate;

    matchedList.push({
      event: ev,
      person,
      isoString,
      logDate
    });
  }

  if (matchedList.length === 0) {
    return result;
  }

  // 3. Query existing attendance logs within time range to prevent duplicate punch recordings
  const earliestIso = new Date(earliestDate.getTime() - 2000).toISOString();
  const latestIso = new Date(latestDate.getTime() + 2000).toISOString();
  const personIds = Array.from(new Set(matchedList.map(m => m.person.id)));

  const { data: existingLogs } = await supabase
    .from('attendance_logs')
    .select('person_id, occurred_at')
    .eq('school_id', device.school_id)
    .in('person_id', personIds)
    .gte('occurred_at', earliestIso)
    .lte('occurred_at', latestIso);

  const existingSet = new Set((existingLogs || []).map(l => `${l.person_id}-${l.occurred_at}`));

  // 4. Resolve School/Device Late Cutoff and TimeZone configuration
  const timeZone = device.config?.timeZone || 'Africa/Kampala';
  const lateCutoffHour = device.config?.lateCutoffHour ?? 8;
  const lateCutoffMinute = device.config?.lateCutoffMinute ?? 0;

  const localTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });

  const deviceLogsToInsert: any[] = [];
  const attendanceLogsToInsert: any[] = [];
  const validStudentRecords: any[] = [];
  const nowIso = new Date().toISOString();

  for (const item of matchedList) {
    const dedupKey = `${item.person.id}-${item.isoString}`;
    if (existingSet.has(dedupKey)) {
      result.skippedDuplicates++;
      continue;
    }
    existingSet.add(dedupKey);

    const deviceLogId = crypto.randomUUID();

    // Device Log (raw hardware audit trail)
    deviceLogsToInsert.push({
      id: deviceLogId,
      device_id: device.id,
      raw_serial_number: device.serial_number,
      device_user_id: item.event.person_external_id,
      event_timestamp: item.isoString,
      payload: {
        vendor_protocol: device.device_type,
        pin: item.event.person_external_id,
        role: item.person.role,
        full_name: item.person.full_name,
        verify_type: item.event.verify_type || 'biometric',
        raw_event: item.event.raw_payload || null
      },
      processed: true,
      processed_at: nowIso
    });

    // Determine status (present vs. late) according to per-school/device cutoff
    const attendanceType = item.event.event_type;
    let isLate = false;
    if (attendanceType === 'check_in') {
      try {
        const parts = localTimeFormatter.formatToParts(item.logDate);
        const localH = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
        const localM = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
        isLate = (localH > lateCutoffHour) || (localH === lateCutoffHour && localM > lateCutoffMinute);
      } catch {
        isLate = false;
      }
    }
    const status = attendanceType === 'check_in' ? (isLate ? 'late' : 'present') : 'present';

    // Attendance Log (business record)
    attendanceLogsToInsert.push({
      school_id: device.school_id,
      person_id: item.person.id,
      source: 'device',
      device_id: device.id,
      device_log_id: deviceLogId,
      status: status,
      attendance_type: attendanceType,
      occurred_at: item.isoString,
      marked_by: null,
      class_id_at_time: item.person.class_id || null,
      class_name_at_time: item.person.classes?.name || (item.person.role === 'teacher' ? 'Faculty Member' : null)
    });

    // Check parent SMS notifications for students
    if (item.person.role === 'student') {
      const windowCheck = isWithinAttendanceSmsWindow(attendanceType, item.logDate, timeZone);
      if (windowCheck.allowed) {
        validStudentRecords.push({
          ...item,
          attendanceType,
          status,
          timeFormatted: windowCheck.eatTimeStr
        });
      }
    }
  }

  // 5. Batch Inserts
  if (deviceLogsToInsert.length > 0) {
    await supabase.from('device_logs').insert(deviceLogsToInsert);
    result.insertedDeviceLogs = deviceLogsToInsert.length;
  }

  if (attendanceLogsToInsert.length > 0) {
    await supabase.from('attendance_logs').insert(attendanceLogsToInsert);
    result.insertedAttendanceLogs = attendanceLogsToInsert.length;
    console.log(`[Device Processor] Saved ${attendanceLogsToInsert.length} attendance records from device ${device.serial_number} (${device.device_type})`);
  }

  // 6. Queue SMS Notifications for Parents
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
          phone: Array.isArray(row.parents) ? (row.parents[0] as any)?.phone : (row.parents as any)?.phone
        });
      }
    }

    const notificationsToInsert: any[] = [];
    for (const record of validStudentRecords) {
      const pInfo = parentMap.get(record.person.id);
      if (pInfo && pInfo.phone) {
        const actionText = record.attendanceType === 'check_in' ? 'arrived safely at school' : 'clocked out from school';
        const timeFormatted = record.timeFormatted || record.logDate.toLocaleTimeString([], { timeZone, hour: '2-digit', minute: '2-digit' });

        notificationsToInsert.push({
          school_id: device.school_id,
          recipient_type: 'parent',
          recipient_id: pInfo.parent_id,
          recipient_phone_snapshot: pInfo.phone,
          channel: 'sms',
          notification_type: 'attendance',
          status: 'pending',
          message: `${record.person.full_name} has ${actionText} at ${timeFormatted}.`
        });
      }
    }

    if (notificationsToInsert.length > 0) {
      await supabase.from('notifications').insert(notificationsToInsert);
      result.queuedSmsCount = notificationsToInsert.length;
      console.log(`[Device Processor] Queued ${notificationsToInsert.length} parent SMS notifications from device ${device.serial_number}`);
    }
  }

  return result;
}
