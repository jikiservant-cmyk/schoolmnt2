import { AttendanceEvent, DeviceRecord } from './types';
import { createAdminClient } from '@/utils/supabase/admin';
import { getAttendanceStatusForCheckIn, isWithinAttendanceSmsWindow } from '@/lib/attendance-window';
import { queueNotifications, attendanceSmsKey } from '@/lib/notifications/queue';
import { isMissingColumnError, extractMissingColumn } from '@/lib/tenant';
import {
  DEFAULT_SCHOOL_POLICY_SETTINGS,
  getSchoolSettings,
  isParentSmsEnabledForEvent,
  renderAttendanceSmsMessage,
} from '@/lib/school-settings';

const AMBIGUOUS_PIN = Symbol('AMBIGUOUS_PIN');
type PinCandidate = any | typeof AMBIGUOUS_PIN;

function canonicalDevicePin(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (/^\d+$/.test(clean)) {
    return clean.replace(/^0+/, '') || '0';
  }
  return clean;
}

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
const MAX_EVENTS_PER_BATCH = 2000;
const DEFAULT_ATTENDANCE_DUPLICATE_WINDOW_SECONDS = DEFAULT_SCHOOL_POLICY_SETTINGS.duplicatePunchWindowSeconds;

function attendanceDuplicateWindowMs(schoolConfiguredSeconds?: number): number {
  const configured = process.env.ATTENDANCE_DUPLICATE_WINDOW_SECONDS;
  if (configured != null && configured.trim() !== '') {
    const parsed = Number(configured);
    if (!Number.isFinite(parsed)) return DEFAULT_ATTENDANCE_DUPLICATE_WINDOW_SECONDS * 1000;
    return Math.trunc(Math.max(0, Math.min(3600, parsed))) * 1000;
  }
  const schoolSecs = schoolConfiguredSeconds ?? DEFAULT_ATTENDANCE_DUPLICATE_WINDOW_SECONDS;
  if (!Number.isFinite(schoolSecs)) return DEFAULT_ATTENDANCE_DUPLICATE_WINDOW_SECONDS * 1000;
  return Math.trunc(Math.max(0, Math.min(3600, schoolSecs))) * 1000;
}

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

  // SECURITY: never trust device-supplied values blindly.
  //  - cap batch size (memory / DB load)
  //  - bound the external id length
  //  - drop timestamps from the future (> 10 min clock skew) or older than
  //    60 days. Previously only the ZKTeco parser checked this, so webhook
  //    devices could write attendance dated 2099 or 1999.
  const nowMs = Date.now();
  const MAX_FUTURE_MS = 10 * 60 * 1000;
  const MAX_PAST_MS = 60 * 24 * 60 * 60 * 1000;
  const sane = events.slice(0, MAX_EVENTS_PER_BATCH).filter((ev) => {
    const id = typeof ev.person_external_id === 'string' ? ev.person_external_id.trim() : '';
    if (!id || id.length > 64) return false;
    const t = ev.timestamp instanceof Date ? ev.timestamp.getTime() : NaN;
    if (!Number.isFinite(t)) return false;
    return t <= nowMs + MAX_FUTURE_MS && t >= nowMs - MAX_PAST_MS;
  });
  if (sane.length !== events.length) {
    console.warn(`[Device Processor] Dropped ${events.length - sane.length} invalid/out-of-range event(s) from ${device.serial_number}`);
  }
  events = sane;
  if (events.length === 0) return result;

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
  const exactMap = new Map<string, PinCandidate>();
  const canonicalMap = new Map<string, PinCandidate>();

  const registerPin = (rawUid: string | null | undefined, personObj: any) => {
    const clean = (rawUid || '').trim().toLowerCase();
    if (!clean) return;

    const prevExact = exactMap.get(clean);
    if (prevExact === undefined) {
      exactMap.set(clean, personObj);
    } else if (prevExact !== AMBIGUOUS_PIN && prevExact.id !== personObj.id) {
      exactMap.set(clean, AMBIGUOUS_PIN);
    }

    const canon = canonicalDevicePin(clean);
    const prevCanon = canonicalMap.get(canon);
    if (prevCanon === undefined) {
      canonicalMap.set(canon, personObj);
    } else if (prevCanon !== AMBIGUOUS_PIN && prevCanon.id !== personObj.id) {
      canonicalMap.set(canon, AMBIGUOUS_PIN);
    }
  };

  for (const p of people) {
    registerPin(p.device_user_id, p);
  }

  // Also resolve from school.person_credentials (multi-vendor credentials), tolerating older schemas without `is_active`
  try {
    let credsQuery = await supabase
      .from('person_credentials')
      .select('identifier_value, person:person_id(id, school_id, full_name, role, class_id, is_active, device_user_id, classes:class_id(id, name))')
      .eq('school_id', device.school_id)
      .eq('is_active', true);

    if (credsQuery.error && extractMissingColumn(credsQuery.error) === 'is_active') {
      credsQuery = await supabase
        .from('person_credentials')
        .select('identifier_value, person:person_id(id, school_id, full_name, role, class_id, is_active, device_user_id, classes:class_id(id, name))')
        .eq('school_id', device.school_id);
    }

    const credsData = credsQuery.data;
    if (credsData) {
      for (const c of credsData) {
        if (!c.identifier_value || !c.person) continue;
        const pObj: any = Array.isArray(c.person) ? c.person[0] : c.person;
        if (!pObj) continue;
        // MULTI-TENANT: a credential row tagged with this school must never
        // resolve to a person who belongs to another school.
        if (pObj.school_id !== device.school_id) {
          console.warn(`[Device Processor] Ignoring cross-tenant credential "${c.identifier_value}" on device ${device.serial_number}`);
          continue;
        }

        registerPin(c.identifier_value, pObj);
      }
    }
  } catch {
    // Non-blocking fallback if person_credentials query fails
  }

  // 2. Filter and match events (exact-match-first + ambiguity guard on canonical fallback)
  const matchedList: {
    event: AttendanceEvent;
    person: any;
    isoString: string;
    logDate: Date;
  }[] = [];

  for (const ev of events) {
    const cleanPin = ev.person_external_id.trim().toLowerCase();
    let candidate: PinCandidate | undefined = exactMap.get(cleanPin);
    if (candidate === undefined) {
      candidate = canonicalMap.get(canonicalDevicePin(cleanPin));
    }

    if (candidate === AMBIGUOUS_PIN) {
      console.warn(`[Device Processor] Ambiguous normalized PIN "${cleanPin}" matches multiple people on device ${device.serial_number}; skipping`);
      result.unrecognizedCount++;
      continue;
    }

    const person = candidate;

    if (person && person.is_active === false) {
      // Deactivated (left / expelled / suspended) people must not be recorded or trigger SMS.
      result.unrecognizedCount++;
      continue;
    }

    if (!person) {
      console.warn(`[Device Processor] Unrecognized external ID "${cleanPin}" on device ${device.serial_number}`);
      result.unrecognizedCount++;
      continue;
    }

    result.matchedCount++;
    const logDate = ev.timestamp instanceof Date && !isNaN(ev.timestamp.getTime()) ? ev.timestamp : new Date();
    const isoString = logDate.toISOString();

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

  // Load per-school configurable policies once per upload batch.
  const schoolSettings = device.schoolSettings || (await getSchoolSettings(supabase, device.school_id));

  // 3. Deduplicate real instants in a configurable window. Processing oldest
  // first preserves the first thumb in a batch, and adding every kept punch to
  // knownPunches also catches repeats inside that same upload.
  matchedList.sort((a, b) => a.logDate.getTime() - b.logDate.getTime());
  const duplicateWindowMs = attendanceDuplicateWindowMs(schoolSettings.duplicatePunchWindowSeconds);
  const earliestMs = matchedList[0].logDate.getTime();
  const latestMs = matchedList[matchedList.length - 1].logDate.getTime();
  const earliestIso = new Date(earliestMs - duplicateWindowMs).toISOString();
  const latestIso = new Date(latestMs + duplicateWindowMs).toISOString();
  const personIds = Array.from(new Set(matchedList.map(m => m.person.id)));

  let existingLogs: any[] = [];
  let existingLogsError: unknown = null;
  try {
    const { data, error } = await supabase
      .from('attendance_logs')
      .select('person_id, attendance_type, occurred_at')
      .eq('school_id', device.school_id)
      .in('person_id', personIds)
      .gte('occurred_at', earliestIso)
      .lte('occurred_at', latestIso);

    if (error) existingLogsError = error;
    else existingLogs = data || [];
  } catch (error) {
    existingLogsError = error;
  }

  if (existingLogsError) {
    // This is a best-effort optimization. The unique database index still
    // rejects exact duplicate device punches if the lookup is unavailable.
    const message = existingLogsError instanceof Error
      ? existingLogsError.message
      : (existingLogsError as { message?: string } | null)?.message || String(existingLogsError);
    console.warn(`[Device Processor] Duplicate attendance lookup failed for ${device.serial_number}; continuing: ${message}`);
  }
  const knownPunches: { person_id: string; attendance_type: string; occurred_at: string }[] =
    existingLogsError ? [] : existingLogs.map((log: any) => ({
      person_id: log.person_id,
      attendance_type: log.attendance_type,
      occurred_at: log.occurred_at
    }));

  // 4. Resolve School/Device Late Cutoff and TimeZone configuration
  const timeZone = device.config?.hasExplicitTimeZone
    ? (device.config.timeZone || schoolSettings.timeZone)
    : schoolSettings.timeZone;
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
    const incomingMs = new Date(item.isoString).getTime();
    const duplicate = knownPunches.some((known) => {
      if (known.person_id !== item.person.id) return false;
      // Check-in and check-out are separate attendance actions and must never
      // be collapsed into one another.
      if (known.attendance_type !== item.event.event_type) return false;

      const knownMs = new Date(known.occurred_at).getTime();
      if (!Number.isFinite(knownMs) || !Number.isFinite(incomingMs)) return false;
      const distanceMs = Math.abs(knownMs - incomingMs);
      if (distanceMs === 0) return true;
      if (duplicateWindowMs === 0) return false;
      return distanceMs < 1000 || distanceMs <= duplicateWindowMs;
    });
    if (duplicate) {
      result.skippedDuplicates++;
      continue;
    }
    knownPunches.push({
      person_id: item.person.id,
      attendance_type: item.event.event_type,
      occurred_at: item.isoString
    });

    const deviceLogId = crypto.randomUUID();

    // Device Log (raw hardware audit trail)
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
        raw_event: item.event.raw_payload || null
      },
      processed: true,
      processed_at: nowIso
    });

    // Determine status (present vs. late) according to per-school or explicit per-device cutoff
    const attendanceType = item.event.event_type;
    let status: 'present' | 'late' = 'present';
    if (attendanceType === 'check_in') {
      if (device.config?.hasExplicitLateCutoff) {
        let isLate = false;
        try {
          const parts = localTimeFormatter.formatToParts(item.logDate);
          const localH = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
          const localM = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
          isLate = (localH > lateCutoffHour) || (localH === lateCutoffHour && localM > lateCutoffMinute);
        } catch {
          isLate = false;
        }
        status = isLate ? 'late' : 'present';
      } else {
        status = getAttendanceStatusForCheckIn(item.logDate, {
          timeZone,
          role: item.person.role,
          studentLateCutoff: schoolSettings.studentLateCutoff,
          studentGraceMinutes: schoolSettings.studentGraceMinutes,
          staffLateCutoff: schoolSettings.staffLateCutoff,
        });
      }
    }

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

    // Check parent SMS notifications for students using per-school toggles + SMS windows
    if (
      item.person.role === 'student' &&
      isParentSmsEnabledForEvent(schoolSettings, attendanceType, status)
    ) {
      const windowCheck = isWithinAttendanceSmsWindow(attendanceType, item.logDate, {
        timeZone,
        restrictSmsWindows: schoolSettings.restrictSmsWindows,
        checkInSmsStart: schoolSettings.checkInSmsStart,
        checkInSmsEnd: schoolSettings.checkInSmsEnd,
        checkOutSmsStart: schoolSettings.checkOutSmsStart,
        checkOutSmsEnd: schoolSettings.checkOutSmsEnd,
      });
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

  // 5. Batch Inserts (with automatic missing-column fallback for pre-migration-10 schemas)
  if (deviceLogsToInsert.length > 0) {
    let rowsToWrite: Record<string, unknown>[] = deviceLogsToInsert.map((r) => ({ ...r }));
    let dlErr: { code?: string; message?: string } | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const ins = await supabase.from('device_logs').insert(rowsToWrite);
      dlErr = ins.error;
      if (!dlErr) break;
      const missing = extractMissingColumn(dlErr);
      if (missing && rowsToWrite.some((r) => Object.prototype.hasOwnProperty.call(r, missing))) {
        console.warn(`[Device Processor] device_logs.${missing} missing; retrying without ${missing}`);
        rowsToWrite = rowsToWrite.map((r) => {
          const copy = { ...r };
          delete copy[missing];
          return copy;
        });
        continue;
      }
      if (isMissingColumnError(dlErr, 'school_id')) {
        rowsToWrite = rowsToWrite.map(({ school_id: _omit, ...row }) => row);
        continue;
      }
      break;
    }
    if (dlErr) {
      // Audit trail only: don't block the attendance record, but don't hide the failure either.
      console.error(`[Device Processor] device_logs insert failed for ${device.serial_number}:`, dlErr.message);
      for (const a of attendanceLogsToInsert) a.device_log_id = null;
    } else {
      result.insertedDeviceLogs = deviceLogsToInsert.length;
    }
  }

  if (attendanceLogsToInsert.length > 0) {
    // RELIABILITY: these errors used to be ignored and the device was told
    // "OK", so it deleted punches that were never saved. Now a failure throws
    // and the route answers 503, so the terminal keeps the punches and retries.
    // Unique-constraint conflicts (an already-stored punch) are skipped row by row.
    const { error: attErr } = await supabase.from('attendance_logs').insert(attendanceLogsToInsert);
    if (attErr) {
      if (attErr.code !== '23505') {
        throw new Error(`attendance_logs insert failed: ${attErr.message}`);
      }
      let stored = 0;
      for (const row of attendanceLogsToInsert) {
        const { error: rowErr } = await supabase.from('attendance_logs').insert(row);
        if (!rowErr) stored++;
        else if (rowErr.code === '23505') result.skippedDuplicates++;
        else throw new Error(`attendance_logs insert failed: ${rowErr.message}`);
      }
      result.insertedAttendanceLogs = stored;
    } else {
      result.insertedAttendanceLogs = attendanceLogsToInsert.length;
    }
  }
  const skippedDuplicatesNote = result.skippedDuplicates
    ? `; skipped ${result.skippedDuplicates} duplicate(s)`
    : '';
  console.log(`[Device Processor] Saved ${result.insertedAttendanceLogs} attendance records from device ${device.serial_number} (${device.device_type})${skippedDuplicatesNote}`);

  // 6. Queue SMS Notifications for Parents
  // COST / ABUSE: one SMS per child per direction per local day. A child
  // who taps the reader 5 times (or a replayed upload) used to trigger 5
  // paid SMS. Attendance rows are still stored for every punch.
  if (validStudentRecords.length > 0) {
    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const ids = Array.from(new Set(validStudentRecords.map(r => r.person.id)));
    const minMs = Math.min(...validStudentRecords.map(r => r.logDate.getTime()));
    const { data: sameDayLogs, error: sdErr } = await supabase
      .from('attendance_logs')
      .select('person_id, attendance_type, occurred_at')
      .eq('school_id', device.school_id)
      .in('person_id', ids)
      .gte('occurred_at', new Date(minMs - 36 * 3600 * 1000).toISOString());
    if (sdErr) {
      console.warn('[Device Processor] SMS de-duplication lookup failed; skipping SMS for safety:', sdErr.message);
      validStudentRecords.length = 0;
    } else {
      const kept: any[] = [];
      const seen = new Set<string>();
      for (const r of validStudentRecords.sort((a, b) => a.logDate.getTime() - b.logDate.getTime())) {
        const k = `${r.person.id}|${r.attendanceType}|${dayKey.format(r.logDate)}`;
        if (seen.has(k)) continue;
        const earlier = (sameDayLogs || []).some((l: any) =>
          l.person_id === r.person.id &&
          l.attendance_type === r.attendanceType &&
          new Date(l.occurred_at).getTime() < r.logDate.getTime() &&
          dayKey.format(new Date(l.occurred_at)) === dayKey.format(r.logDate));
        seen.add(k);
        if (!earlier) kept.push(r);
      }
      validStudentRecords.length = 0;
      validStudentRecords.push(...kept);
    }
  }

  if (validStudentRecords.length > 0) {
    const sIds = Array.from(new Set(validStudentRecords.map(r => r.person.id)));
    const { data: parentsData } = await supabase
      .from('student_parents')
      .select('student_id, parent_id, parents(phone, school_id)')
      .in('student_id', sIds)
      .eq('is_primary_contact', true);

    const parentMap = new Map();
    if (parentsData) {
      for (const row of parentsData) {
        const parentRow: any = Array.isArray(row.parents) ? row.parents[0] : row.parents;
        // MULTI-TENANT: only notify guardians registered in the same school.
        if (!parentRow || parentRow.school_id !== device.school_id) continue;
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
        const timeFormatted = record.timeFormatted || record.logDate.toLocaleTimeString([], { timeZone, hour: '2-digit', minute: '2-digit' });
        const messageText = renderAttendanceSmsMessage(schoolSettings, record.attendanceType, {
          studentName: record.person.full_name,
          schoolName: schoolSettings.schoolName,
          time: timeFormatted,
          className: record.person.classes?.name || null,
          status: record.status,
        });

        notificationsToInsert.push({
          dedupe_key: attendanceSmsKey(record.person.id, record.attendanceType, record.logDate, timeZone),
          school_id: device.school_id,
          recipient_type: 'parent',
          recipient_id: pInfo.parent_id,
          recipient_phone_snapshot: pInfo.phone,
          channel: 'sms',
          notification_type: 'attendance',
          status: 'pending',
          message: messageText
        });
      }
    }

    if (notificationsToInsert.length > 0) {
      // Never fail the upload over SMS (the punches are already saved).
      try {
        const { queued, duplicates } = await queueNotifications(supabase, notificationsToInsert);
        result.queuedSmsCount = queued;
        console.log(`[Device Processor] Queued ${queued} parent SMS notifications from device ${device.serial_number}${duplicates ? ` (${duplicates} already queued today)` : ''}`);
      } catch (e) {
        console.error(`[Device Processor] SMS queue failed for ${device.serial_number}:`, e);
      }
    }
  }

  return result;
}
