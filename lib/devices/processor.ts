import { AttendanceEvent, DeviceRecord } from './types';
import { createAdminClient } from '@/utils/supabase/admin';
import { getAttendanceStatusForCheckIn, isWithinAttendanceSmsWindow } from '@/lib/attendance-window';
import { queueNotifications, attendanceSmsKey } from '@/lib/notifications/queue';
import { isMissingColumnError, extractMissingColumn } from '@/lib/tenant';
import {
  getSchoolSettings,
  isParentSmsEnabledForEvent,
  parseHhMmToMinutes,
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
 *
 * STRICT TWO-WRITE DAILY ATTENDANCE RULE:
 *   Every person gets AT MOST TWO (`2`) attendance records per school day:
 *     1. ONE (`1`) Morning Thumb-In (`attendance_type = 'check_in'`) before `afternoonSwitchoverTime`
 *     2. ONE (`1`) Evening Thumb-Out (`attendance_type = 'check_out'`) at/after `afternoonSwitchoverTime`
 *        (or when hardware explicitly sends a `check_out` status code).
 *   Repeated thumbs in the morning or repeated thumbs in the evening produce ZERO extra
 *   writes in both `school.attendance_logs` and `school.device_logs` and ZERO extra SMS.
 */
const MAX_EVENTS_PER_BATCH = 2000;

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

  // Load per-school operational settings once per upload batch.
  const schoolSettings = device.schoolSettings || (await getSchoolSettings(supabase, device.school_id));
  const timeZone = device.config?.hasExplicitTimeZone
    ? (device.config.timeZone || schoolSettings.timeZone)
    : schoolSettings.timeZone;
  const switchoverMinutes = parseHhMmToMinutes(schoolSettings.afternoonSwitchoverTime, 13 * 60);
  const lateCutoffHour = device.config?.lateCutoffHour ?? 8;
  const lateCutoffMinute = device.config?.lateCutoffMinute ?? 0;

  const localDateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });

  const getLocalSlotInfo = (dt: Date, rawEventType: 'check_in' | 'check_out') => {
    const localDateKey = localDateFormatter.format(dt);
    let localH = 0;
    let localM = 0;
    try {
      const parts = localTimeFormatter.formatToParts(dt);
      localH = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10) % 24;
      localM = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
    } catch {
      localH = dt.getUTCHours();
      localM = dt.getUTCMinutes();
    }
    const localMinutes = localH * 60 + localM;
    // STRICT DAILY SESSION MAPPING:
    //   - Morning (`localMinutes < switchoverMinutes`, unless hardware explicitly sent `check_out`) -> `check_in`
    //   - Afternoon / Evening (`localMinutes >= switchoverMinutes`, or explicit `check_out`) -> `check_out`
    const attendanceType: 'check_in' | 'check_out' =
      rawEventType === 'check_out' || localMinutes >= switchoverMinutes
        ? 'check_out'
        : 'check_in';
    return { localDateKey, localH, localM, attendanceType };
  };

  // 3. Chronological ordering (oldest thumb wins the morning/evening slot) +
  //    full-day lookup so AT MOST ONE `check_in` and AT MOST ONE `check_out`
  //    is ever written per person per local calendar day.
  matchedList.sort((a, b) => a.logDate.getTime() - b.logDate.getTime());
  const DAY_SPAN_PAD_MS = 30 * 60 * 60 * 1000;
  const earliestIso = new Date(matchedList[0].logDate.getTime() - DAY_SPAN_PAD_MS).toISOString();
  const latestIso = new Date(matchedList[matchedList.length - 1].logDate.getTime() + DAY_SPAN_PAD_MS).toISOString();
  const personIds = Array.from(new Set(matchedList.map((m) => m.person.id)));

  const recordedSlots = new Set<string>();
  const existingAbsentRows = new Map<string, string>();

  try {
    const { data, error } = await supabase
      .from('attendance_logs')
      .select('id, person_id, attendance_type, status, occurred_at')
      .eq('school_id', device.school_id)
      .in('person_id', personIds)
      .gte('occurred_at', earliestIso)
      .lte('occurred_at', latestIso);

    if (error) {
      console.warn(`[Device Processor] Daily slot lookup failed for ${device.serial_number}; DB unique index still enforces 2/day limit: ${error.message}`);
    } else if (data) {
      for (const row of data) {
        if (!row.person_id || !row.occurred_at) continue;
        const rowDt = new Date(row.occurred_at);
        if (isNaN(rowDt.getTime())) continue;
        const dateKey = localDateFormatter.format(rowDt);
        const typeKey: 'check_in' | 'check_out' = row.attendance_type === 'check_out' ? 'check_out' : 'check_in';
        const slotKey = `${row.person_id}|${dateKey}|${typeKey}`;
        if (row.status === 'absent') {
          existingAbsentRows.set(slotKey, row.id);
        } else {
          recordedSlots.add(slotKey);
        }
      }
    }
  } catch (error: any) {
    console.warn(`[Device Processor] Daily slot lookup error for ${device.serial_number}: ${error?.message || error}`);
  }

  const deviceLogsToInsert: any[] = [];
  const attendanceLogsToInsert: any[] = [];
  const absentUpgrades: { existingId: string; row: any }[] = [];
  const candidateStudentSmsBySlot = new Map<string, any>();
  const nowIso = new Date().toISOString();

  for (const item of matchedList) {
    const { localDateKey, localH, localM, attendanceType } = getLocalSlotInfo(
      item.logDate,
      item.event.event_type
    );
    const slotKey = `${item.person.id}|${localDateKey}|${attendanceType}`;

    // Already recorded for this day's Morning (`check_in`) or Evening (`check_out`) slot:
    // ZERO database writes to `device_logs`, `attendance_logs`, or `notifications`!
    if (recordedSlots.has(slotKey)) {
      result.skippedDuplicates++;
      continue;
    }
    recordedSlots.add(slotKey);

    const deviceLogId = crypto.randomUUID();

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
        attendance_type: attendanceType,
        verify_type: item.event.verify_type || 'biometric',
        raw_event: item.event.raw_payload || null
      },
      processed: true,
      processed_at: nowIso
    });

    let status: 'present' | 'late' = 'present';
    if (attendanceType === 'check_in') {
      if (device.config?.hasExplicitLateCutoff) {
        const isLate = (localH > lateCutoffHour) || (localH === lateCutoffHour && localM > lateCutoffMinute);
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

    const rowPayload = {
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
      class_name_at_time: item.person.classes?.name || (item.person.role === 'teacher' ? 'Faculty Member' : null),
      __slotKey: slotKey,
    };

    const existingAbsentId = existingAbsentRows.get(slotKey);
    if (existingAbsentId) {
      absentUpgrades.push({ existingId: existingAbsentId, row: rowPayload });
    } else {
      attendanceLogsToInsert.push(rowPayload);
    }

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
        candidateStudentSmsBySlot.set(slotKey, {
          ...item,
          attendanceType,
          status,
          timeFormatted: windowCheck.eatTimeStr
        });
      }
    }
  }

  // 5. Persist strictly the winning daily slots (`<= 1 check_in + <= 1 check_out` per person)
  const storedSlotKeys = new Set<string>();
  const orphanDeviceLogIds: string[] = [];

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
      console.error(`[Device Processor] device_logs insert failed for ${device.serial_number}:`, dlErr.message);
      for (const a of attendanceLogsToInsert) a.device_log_id = null;
      for (const u of absentUpgrades) u.row.device_log_id = null;
    } else {
      result.insertedDeviceLogs = deviceLogsToInsert.length;
    }
  }

  // Upgrade any earlier manual `absent` rows in place so offline buffered punches never create a 2nd row
  for (const upg of absentUpgrades) {
    const { __slotKey, ...cleanRow } = upg.row;
    const { error: upgErr } = await supabase
      .from('attendance_logs')
      .update({
        source: 'device',
        device_id: cleanRow.device_id,
        device_log_id: cleanRow.device_log_id,
        status: cleanRow.status,
        occurred_at: cleanRow.occurred_at,
        marked_by: null,
      })
      .eq('id', upg.existingId);
    if (!upgErr) {
      result.insertedAttendanceLogs++;
      storedSlotKeys.add(__slotKey);
    }
  }

  if (attendanceLogsToInsert.length > 0) {
    const rowsForDb = attendanceLogsToInsert.map(({ __slotKey: _s, ...rest }) => rest);
    const { error: attErr } = await supabase.from('attendance_logs').insert(rowsForDb);
    if (attErr) {
      if (attErr.code !== '23505') {
        throw new Error(`attendance_logs insert failed: ${attErr.message}`);
      }
      let stored = 0;
      for (const rawRow of attendanceLogsToInsert) {
        const { __slotKey, ...row } = rawRow;
        const { error: rowErr } = await supabase.from('attendance_logs').insert(row);
        if (!rowErr) {
          stored++;
          storedSlotKeys.add(__slotKey);
        } else if (rowErr.code === '23505') {
          result.skippedDuplicates++;
          if (row.device_log_id) orphanDeviceLogIds.push(row.device_log_id);
        } else {
          throw new Error(`attendance_logs insert failed: ${rowErr.message}`);
        }
      }
      result.insertedAttendanceLogs += stored;
    } else {
      result.insertedAttendanceLogs += attendanceLogsToInsert.length;
      for (const r of attendanceLogsToInsert) storedSlotKeys.add(r.__slotKey);
    }
  }

  // Remove any device_logs created during a parallel millisecond race where PostgreSQL rejected the 2nd write
  if (orphanDeviceLogIds.length > 0) {
    await supabase.from('device_logs').delete().in('id', orphanDeviceLogIds);
    result.insertedDeviceLogs = Math.max(0, result.insertedDeviceLogs - orphanDeviceLogIds.length);
  }

  const skippedDuplicatesNote = result.skippedDuplicates
    ? `; skipped ${result.skippedDuplicates} duplicate(s)`
    : '';
  console.log(`[Device Processor] Saved ${result.insertedAttendanceLogs} attendance records from device ${device.serial_number} (${device.device_type})${skippedDuplicatesNote}`);

  // 6. Queue Parent SMS ONLY for winning slots actually stored in PostgreSQL
  const validStudentRecords = Array.from(candidateStudentSmsBySlot.entries())
    .filter(([slotKey]) => storedSlotKeys.has(slotKey))
    .map(([, rec]) => rec);

  if (validStudentRecords.length > 0) {
    const sIds = Array.from(new Set(validStudentRecords.map((r) => r.person.id)));
    const { data: parentsData } = await supabase
      .from('student_parents')
      .select('student_id, parent_id, parents(phone, school_id)')
      .in('student_id', sIds)
      .eq('is_primary_contact', true);

    const parentMap = new Map();
    if (parentsData) {
      for (const row of parentsData) {
        const parentRow: any = Array.isArray(row.parents) ? row.parents[0] : row.parents;
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
