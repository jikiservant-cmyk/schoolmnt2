import { createHash } from 'node:crypto';

const EAT_TIME_ZONE = 'Africa/Kampala';

function attendanceDayKey(occurredAt: Date | string): string {
  const date = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('Attendance timestamp must be a valid date.');
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EAT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new Error('Could not resolve East Africa attendance date.');
  return `${year}-${month}-${day}`;
}

function uuidFromStableKey(stableKey: string): string {
  const bytes = createHash('sha256').update(stableKey).digest().subarray(0, 16);
  // Use RFC 4122 version/variant bits so the deterministic key remains a UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Attendance is recorded at most once per school/person/type per EAT calendar
 * day. A stable UUID and unique key make concurrent retries idempotent at the
 * database boundary, rather than relying only on a prior SELECT.
 */
export function createAttendanceIdentity(
  schoolId: string,
  personId: string,
  attendanceType: string,
  occurredAt: Date | string,
): { id: string; idempotency_key: string } {
  if (!schoolId || !personId || !attendanceType) {
    throw new TypeError('School, person, and attendance type are required.');
  }
  const day = attendanceDayKey(occurredAt);
  const idempotencyKey = `attendance:v1:${schoolId}:${personId}:${attendanceType}:${day}`;
  return {
    id: uuidFromStableKey(idempotencyKey),
    idempotency_key: idempotencyKey,
  };
}
