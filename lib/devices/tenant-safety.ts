import type { AttendanceEvent, DeviceRecord } from './types';
import type { AttendanceType, AttendanceLogSummary } from '@/lib/attendance/marking';

export interface TenantPersonSummary {
  id?: string;
  school_id?: string | null;
  is_active?: boolean | null;
}

export function isDeviceOwnedBySchool(
  device: Pick<DeviceRecord, 'school_id'> | null | undefined,
  schoolId: string
): boolean {
  return Boolean(device && schoolId && device.school_id === schoolId);
}

export interface PunchTimestampIndex {
  byPerson: Map<string, Array<{ timestamp: number; attendanceType: string; record: AttendanceLogSummary }>>;
}

/** Ensure a normalized event came from the authenticated device resolved by the route. */
export function isEventOwnedByDevice(event: AttendanceEvent, device: DeviceRecord): boolean {
  return Boolean(
    event &&
    device &&
    event.school_id === device.school_id &&
    event.device_id === device.id &&
    typeof event.person_external_id === 'string' &&
    event.person_external_id.trim() !== '' &&
    (event.event_type === 'check_in' || event.event_type === 'check_out') &&
    event.timestamp instanceof Date &&
    Number.isFinite(event.timestamp.getTime())
  );
}

/** Reject nested credential/person relations that cross the device's tenant. */
export function isPersonInSchool(
  person: TenantPersonSummary | null | undefined,
  schoolId: string
): person is TenantPersonSummary & { id: string; school_id: string } {
  return Boolean(
    person &&
    typeof person.id === 'string' &&
    person.school_id === schoolId &&
    person.is_active !== false
  );
}

export function createPunchTimestampIndex(
  logs: readonly AttendanceLogSummary[]
): PunchTimestampIndex {
  const byPerson = new Map<string, Array<{ timestamp: number; attendanceType: string; record: AttendanceLogSummary }>>();

  for (const log of logs) {
    if (!log.person_id || !log.occurred_at) continue;
    const timestamp = new Date(log.occurred_at).getTime();
    if (!Number.isFinite(timestamp)) continue;
    const records = byPerson.get(log.person_id) || [];
    records.push({ timestamp, attendanceType: log.attendance_type || '', record: log });
    byPerson.set(log.person_id, records);
  }

  return { byPerson };
}

/** Return the existing punch if the same person/type was scanned within the de-duplication window. */
export function findNearDuplicatePunch(
  index: PunchTimestampIndex,
  personId: string,
  occurredAt: string | Date,
  attendanceType: AttendanceType,
  windowMs = 2_000
): AttendanceLogSummary | null {
  const timestamp = occurredAt instanceof Date ? occurredAt.getTime() : new Date(occurredAt).getTime();
  if (!Number.isFinite(timestamp)) return null;

  const matches = index.byPerson.get(personId) || [];
  return matches.find(item =>
    item.attendanceType === attendanceType && Math.abs(item.timestamp - timestamp) <= windowMs
  )?.record || null;
}

export function rememberPunch(
  index: PunchTimestampIndex,
  personId: string,
  occurredAt: string | Date,
  attendanceType: AttendanceType,
  record: AttendanceLogSummary
): void {
  const timestamp = occurredAt instanceof Date ? occurredAt.getTime() : new Date(occurredAt).getTime();
  if (!Number.isFinite(timestamp)) return;
  const matches = index.byPerson.get(personId) || [];
  matches.push({ timestamp, attendanceType, record });
  index.byPerson.set(personId, matches);
}
