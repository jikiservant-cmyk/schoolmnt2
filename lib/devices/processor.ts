import type { AttendanceEvent, DeviceRecord } from './types';
import { createAdminClient } from '@/utils/supabase/admin';
import { isWithinAttendanceSmsWindow } from '@/lib/attendance-window';
import { createAttendanceIdentity } from '@/lib/attendance/idempotency';
import {
  createPunchTimestampIndex,
  findNearDuplicatePunch,
  isEventOwnedByDevice,
  isPersonInSchool,
  rememberPunch,
} from '@/lib/devices/tenant-safety';

export interface ProcessEventsResult {
  totalReceived: number;
  matchedCount: number;
  unrecognizedCount: number;
  insertedAttendanceLogs: number;
  insertedDeviceLogs: number;
  queuedSmsCount: number;
  skippedDuplicates: number;
  invalidTenantEventCount: number;
  errors: string[];
}

function getIdentifierVariants(rawIdentifier: unknown): string[] {
  if (typeof rawIdentifier !== 'string') return [];
  const original = rawIdentifier.trim();
  if (!original) return [];
  const identifier = original.toLowerCase();
  const lowerVariants = [
    identifier,
    identifier.replace(/^0+/, ''),
    identifier.padStart(4, '0'),
  ];
  const originalVariants = [
    original,
    original.replace(/^0+/, ''),
    original.padStart(4, '0'),
  ];
  return Array.from(new Set([...originalVariants, ...lowerVariants])).filter(Boolean);
}

function getNormalizedIdentifierVariants(rawIdentifier: unknown): string[] {
  return getIdentifierVariants(rawIdentifier).map(identifier => identifier.toLowerCase());
}

function addPersonIdentifier(map: Map<string, any | null>, rawIdentifier: unknown, person: any) {
  for (const variant of getNormalizedIdentifierVariants(rawIdentifier)) {
    if (!map.has(variant)) {
      map.set(variant, person);
    } else if (map.get(variant)?.id !== person.id) {
      // An ambiguous PIN must not be assigned to an arbitrary person.
      map.set(variant, null);
    }
  }
}

function chunksOf<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function oneRelation<T>(relation: T | T[] | null | undefined): T | null {
  if (Array.isArray(relation)) return relation[0] || null;
  return relation || null;
}

/**
 * Normalized attendance event processor for all device vendors.
 * Every event must match the authenticated device and tenant, all identity
 * lookups are tenant-scoped, repeated scans are de-duplicated, and database/SMS
 * queue errors are returned to the device route instead of being silently lost.
 */
export async function processAttendanceEvents(
  events: AttendanceEvent[],
  device: DeviceRecord
): Promise<ProcessEventsResult> {
  const result: ProcessEventsResult = {
    totalReceived: Array.isArray(events) ? events.length : 0,
    matchedCount: 0,
    unrecognizedCount: 0,
    insertedAttendanceLogs: 0,
    insertedDeviceLogs: 0,
    queuedSmsCount: 0,
    skippedDuplicates: 0,
    invalidTenantEventCount: 0,
    errors: [],
  };

  if (!Array.isArray(events) || events.length === 0) return result;
  if (!device?.id || !device.school_id || !device.serial_number) {
    result.errors.push('Authenticated device is missing a valid school/device identity.');
    result.invalidTenantEventCount = events.length;
    return result;
  }

  const invalidEvents = events.filter(event => !isEventOwnedByDevice(event, device));
  if (invalidEvents.length > 0) {
    result.invalidTenantEventCount = invalidEvents.length;
    result.errors.push('Rejected attendance event(s) whose device or school did not match the authenticated device.');
    return result;
  }

  const supabase = createAdminClient();

  // Query only the identifiers present in this bounded event batch. Loading the
  // entire school roster on every device push is both wasteful and vulnerable to
  // PostgREST row caps omitting enrolled members on larger schools.
  const candidateIdentifiers = Array.from(new Set(
    events.flatMap(event => getIdentifierVariants(event.person_external_id))
  ));
  const personMap = new Map<string, any | null>();
  const peopleSelect = 'id, school_id, full_name, role, class_id, is_active, device_user_id, classes:class_id(id, name, school_id)';

  for (const identifierChunk of chunksOf(candidateIdentifiers, 200)) {
    const { data: peopleData, error: peopleError } = await supabase
      .from('people')
      .select(peopleSelect)
      .eq('school_id', device.school_id)
      .eq('is_active', true)
      .in('device_user_id', identifierChunk);

    if (peopleError) {
      console.error(`[Device Processor] Failed to resolve enrolled users for school ${device.school_id}:`, peopleError);
      result.errors.push('Failed to load this school\'s enrolled biometric users.');
      return result;
    }
    for (const person of peopleData || []) {
      if (!isPersonInSchool(person, device.school_id)) continue;
      addPersonIdentifier(personMap, person.device_user_id, person);
    }
  }

  // Optional multi-vendor credentials are also looked up only for this batch.
  // The nested person is independently checked in case a relationship is bad.
  for (const identifierChunk of chunksOf(candidateIdentifiers, 200)) {
    try {
      const { data: credentials, error: credentialError } = await supabase
        .from('person_credentials')
        .select('identifier_value, person:person_id(id, school_id, full_name, role, class_id, is_active, device_user_id, classes:class_id(id, name, school_id))')
        .eq('school_id', device.school_id)
        .eq('is_active', true)
        .in('identifier_value', identifierChunk);

      if (credentialError) {
        const optionalSchemaMissing = ['PGRST205', '42P01', '42703'].includes(credentialError.code || '');
        if (!optionalSchemaMissing) {
          console.error(`[Device Processor] Secondary credential lookup failed for school ${device.school_id}:`, credentialError);
          result.errors.push('Failed to verify secondary biometric credentials.');
          return result;
        }
        console.warn(`[Device Processor] Secondary credential schema is not installed for school ${device.school_id}:`, credentialError.code);
      } else {
        for (const credential of credentials || []) {
          const person = oneRelation(credential.person) as any;
          if (!credential.identifier_value || !isPersonInSchool(person, device.school_id)) continue;
          addPersonIdentifier(personMap, credential.identifier_value, person);
        }
      }
    } catch (credentialError) {
      console.error('[Device Processor] Secondary credential lookup threw unexpectedly:', credentialError);
      result.errors.push('Failed to verify secondary biometric credentials.');
      return result;
    }
  }

  // 2. Match incoming external IDs. Unknown/ambiguous IDs never fall through to
  // a person in another tenant or to an arbitrary duplicate PIN.
  const matchedList: Array<{
    event: AttendanceEvent;
    person: any;
    isoString: string;
    logDate: Date;
  }> = [];

  for (const event of events) {
    const cleanIdentifier = event.person_external_id.trim().toLowerCase();
    const identifierVariants = [
      cleanIdentifier,
      cleanIdentifier.replace(/^0+/, ''),
      cleanIdentifier.padStart(4, '0'),
    ];
    let person: any | null = null;
    for (const identifier of new Set(identifierVariants)) {
      if (personMap.has(identifier)) {
        person = personMap.get(identifier) || null;
        break;
      }
    }

    if (!person || !isPersonInSchool(person, device.school_id)) {
      console.warn(`[Device Processor] Unrecognized or ambiguous external ID on device ${device.serial_number}`);
      result.unrecognizedCount++;
      continue;
    }

    const logDate = event.timestamp;
    result.matchedCount++;
    matchedList.push({
      event,
      person,
      isoString: logDate.toISOString(),
      logDate,
    });
  }

  if (matchedList.length === 0) return result;

  // 3. Read prior punches inside a small time range. The query itself is
  // tenant-scoped; a school B row cannot suppress or influence school A scans.
  let earliestMs = Number.POSITIVE_INFINITY;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const match of matchedList) {
    earliestMs = Math.min(earliestMs, match.logDate.getTime());
    latestMs = Math.max(latestMs, match.logDate.getTime());
  }
  const earliestIso = new Date(earliestMs - 2_000).toISOString();
  const latestIso = new Date(latestMs + 2_000).toISOString();
  const personIds = Array.from(new Set(matchedList.map(match => match.person.id)));

  const { data: existingLogs, error: existingLogsError } = await supabase
    .from('attendance_logs')
    .select('id, person_id, attendance_type, occurred_at')
    .eq('school_id', device.school_id)
    .in('person_id', personIds)
    .gte('occurred_at', earliestIso)
    .lte('occurred_at', latestIso);

  if (existingLogsError) {
    console.error('[Device Processor] Failed to check duplicate attendance:', existingLogsError);
    result.errors.push('Could not verify duplicate attendance scans.');
    return result;
  }

  const punchIndex = createPunchTimestampIndex(existingLogs || []);

  // 4. Calculate lateness using the device's school-specific timezone/cutoff.
  const timeZone = device.config?.timeZone || 'Africa/Kampala';
  const lateCutoffHour = device.config?.lateCutoffHour ?? 8;
  const lateCutoffMinute = device.config?.lateCutoffMinute ?? 0;
  const localTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });

  const deviceLogsToInsert: any[] = [];
  const attendanceLogsToInsert: any[] = [];
  const studentRecordsForSms: Array<{
    attendanceLogId: string;
    person: any;
    attendanceType: 'check_in' | 'check_out';
    status: 'present' | 'late';
    logDate: Date;
    timeFormatted: string;
  }> = [];
  const nowIso = new Date().toISOString();

  for (const item of matchedList) {
    const attendanceType = item.event.event_type;
    let attendanceLogId: string;
    let status: 'present' | 'late' = 'present';
    const duplicate = findNearDuplicatePunch(
      punchIndex,
      item.person.id,
      item.isoString,
      attendanceType
    );

    if (duplicate) {
      result.skippedDuplicates++;
      attendanceLogId = duplicate.id || '';
      if (!attendanceLogId) continue;
    } else {
      const deviceLogId = crypto.randomUUID();
      const attendanceIdentity = createAttendanceIdentity(
        device.school_id,
        item.person.id,
        attendanceType,
        item.isoString,
      );
      attendanceLogId = attendanceIdentity.id;

      deviceLogsToInsert.push({
        id: deviceLogId,
        school_id: device.school_id,
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
          raw_event: item.event.raw_payload || null,
        },
        processed: false,
        processed_at: null,
      });

      if (attendanceType === 'check_in') {
        try {
          const parts = localTimeFormatter.formatToParts(item.logDate);
          const localHour = Number.parseInt(parts.find(part => part.type === 'hour')?.value || '0', 10);
          const localMinute = Number.parseInt(parts.find(part => part.type === 'minute')?.value || '0', 10);
          status = localHour > lateCutoffHour || (localHour === lateCutoffHour && localMinute > lateCutoffMinute)
            ? 'late'
            : 'present';
        } catch {
          status = 'present';
        }
      }

      const relatedClass = oneRelation(item.person.classes) as any;
      const className = relatedClass?.school_id === device.school_id
        ? relatedClass.name
        : (item.person.role === 'teacher' ? 'Faculty Member' : null);

      const attendanceRecord = {
        id: attendanceLogId,
        idempotency_key: attendanceIdentity.idempotency_key,
        school_id: device.school_id,
        person_id: item.person.id,
        source: 'device',
        device_id: device.id,
        device_log_id: deviceLogId,
        status,
        attendance_type: attendanceType,
        occurred_at: item.isoString,
        marked_by: null,
        class_id_at_time: relatedClass?.school_id === device.school_id ? item.person.class_id || null : null,
        class_name_at_time: className,
      };
      attendanceLogsToInsert.push(attendanceRecord);
      rememberPunch(punchIndex, item.person.id, item.isoString, attendanceType, attendanceRecord);
    }

    if (item.person.role === 'student') {
      const windowCheck = isWithinAttendanceSmsWindow(attendanceType, item.logDate, timeZone);
      if (windowCheck.allowed) {
        studentRecordsForSms.push({
          attendanceLogId,
          person: item.person,
          attendanceType,
          status,
          logDate: item.logDate,
          timeFormatted: windowCheck.eatTimeStr,
        });
      }
    }
  }

  // 5. Persist raw device events, then attendance facts. Don't claim success or
  // queue SMS if either write failed; device routes return a retryable error.
  if (deviceLogsToInsert.length > 0) {
    const { error: deviceLogError } = await supabase
      .from('device_logs')
      .insert(deviceLogsToInsert);
    if (deviceLogError) {
      console.error('[Device Processor] Failed to persist raw device logs:', deviceLogError);
      result.errors.push('Failed to save biometric device audit logs.');
      return result;
    }
    result.insertedDeviceLogs = deviceLogsToInsert.length;
  }

  if (attendanceLogsToInsert.length > 0) {
    const { data: savedAttendanceRows, error: attendanceInsertError } = await supabase
      .from('attendance_logs')
      .upsert(attendanceLogsToInsert, {
        onConflict: 'school_id,idempotency_key',
        ignoreDuplicates: true,
      })
      .select('id');
    if (attendanceInsertError) {
      console.error('[Device Processor] Failed to persist attendance rows:', attendanceInsertError);
      result.errors.push('Failed to save attendance records.');
      return result;
    }
    result.insertedAttendanceLogs = savedAttendanceRows?.length || 0;
    result.skippedDuplicates += attendanceLogsToInsert.length - result.insertedAttendanceLogs;

    const { error: markProcessedError } = await supabase
      .from('device_logs')
      .update({ processed: true, processed_at: nowIso })
      .eq('school_id', device.school_id)
      .in('id', deviceLogsToInsert.map(log => log.id));
    if (markProcessedError) {
      console.error('[Device Processor] Attendance saved, but audit log processing state failed:', markProcessedError);
      result.errors.push('Attendance saved, but device audit status could not be updated.');
    }
  }

  // 6. Queue SMS notifications with explicit tenant and attendance references.
  // A database unique key plus ignore-duplicates makes concurrent retries safe.
  if (studentRecordsForSms.length > 0) {
    const pendingRecords = studentRecordsForSms;
    const studentIdsForSms = Array.from(new Set(pendingRecords.map(record => record.person.id)));
    const { data: parentLinks, error: parentError } = await supabase
      .from('student_parents')
      .select('student_id, parent_id, is_primary_contact, parents(phone, school_id)')
      .in('student_id', studentIdsForSms)
      .eq('is_primary_contact', true);

    if (parentError) {
      console.error('[Device Processor] Failed to resolve parent SMS recipients:', parentError);
      result.errors.push('Attendance was saved, but SMS recipients could not be verified.');
      return result;
    }

    const parentByStudent = new Map<string, { parentId: string; phone: string }>();
    for (const link of parentLinks || []) {
      const parent = oneRelation(link.parents) as any;
      if (parent?.school_id !== device.school_id || !parent.phone || parentByStudent.has(link.student_id)) continue;
      parentByStudent.set(link.student_id, { parentId: link.parent_id, phone: parent.phone });
    }

    const notificationsToInsert: any[] = [];
    for (const record of pendingRecords) {
      const parent = parentByStudent.get(record.person.id);
      if (!parent) continue;
      const actionText = record.attendanceType === 'check_in'
        ? 'arrived safely at school'
        : 'clocked out from school';
      const timeFormatted = record.timeFormatted || record.logDate.toLocaleTimeString([], {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
      });
      notificationsToInsert.push({
        school_id: device.school_id,
        recipient_type: 'parent',
        recipient_id: parent.parentId,
        recipient_phone_snapshot: parent.phone,
        channel: 'sms',
        notification_type: 'attendance',
        related_table: 'attendance_logs',
        related_id: record.attendanceLogId,
        status: 'pending',
        message: `${record.person.full_name} has ${actionText} at ${timeFormatted}.`,
      });
    }

    if (notificationsToInsert.length > 0) {
      const { data: queuedRows, error: notificationInsertError } = await supabase
        .from('notifications')
        .upsert(notificationsToInsert, {
          onConflict: 'school_id,notification_type,related_id,channel',
          ignoreDuplicates: true,
        })
        .select('id');
      if (notificationInsertError) {
        console.error('[Device Processor] Failed to queue attendance SMS notifications:', notificationInsertError);
        result.errors.push('Attendance was saved, but SMS notifications could not be queued.');
      } else {
        result.queuedSmsCount = queuedRows?.length || 0;
      }
    }
  }

  return result;
}
