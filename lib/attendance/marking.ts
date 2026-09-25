export type AttendanceType = 'check_in' | 'check_out';

export interface AttendanceLogSummary {
  person_id?: string;
  attendance_type?: string | null;
  occurred_at?: string | null;
  id?: string;
}

export type AttendanceSelectionResult =
  | { ok: true; presentStudentIds: string[]; absentStudentIds: string[] }
  | { ok: false; error: string };

export function isAttendanceType(value: unknown): value is AttendanceType {
  return value === 'check_in' || value === 'check_out';
}

/** Returns the next kiosk action, or null once both daily punches exist. */
export function getNextKioskAttendanceType(
  logs: readonly Pick<AttendanceLogSummary, 'attendance_type'>[]
): AttendanceType | null {
  const hasCheckIn = logs.some(log => log.attendance_type === 'check_in');
  const hasCheckOut = logs.some(log => log.attendance_type === 'check_out');

  if (hasCheckIn && hasCheckOut) return null;
  return hasCheckIn ? 'check_out' : 'check_in';
}

/**
 * Reject malformed, duplicate, overlapping, or out-of-class student selections.
 * `allowedStudentIds` must already be fetched from the caller's tenant/class scope.
 */
export function validateAttendanceSelection(
  presentIds: unknown,
  absentIds: unknown,
  allowedStudentIds: ReadonlySet<string>
): AttendanceSelectionResult {
  if (!Array.isArray(presentIds) || !Array.isArray(absentIds)) {
    return { ok: false, error: 'Invalid attendance selection.' };
  }

  const allIds = [...presentIds, ...absentIds];
  if (allIds.some(id => typeof id !== 'string' || id.trim() === '')) {
    return { ok: false, error: 'Invalid student reference provided.' };
  }

  const presentStudentIds = presentIds as string[];
  const absentStudentIds = absentIds as string[];
  const presentSet = new Set(presentStudentIds);
  const absentSet = new Set(absentStudentIds);

  if (presentSet.size !== presentStudentIds.length || absentSet.size !== absentStudentIds.length) {
    return { ok: false, error: 'Duplicate student selection provided.' };
  }

  if (presentStudentIds.some(id => absentSet.has(id))) {
    return { ok: false, error: 'A student cannot be marked both present and absent.' };
  }

  if (allIds.some(id => !allowedStudentIds.has(id as string))) {
    return { ok: false, error: 'Invalid student reference provided.' };
  }

  return { ok: true, presentStudentIds, absentStudentIds };
}

/**
 * Filters present IDs already recorded for the requested attendance period.
 * Input is expected to come from a school-scoped query.
 */
export function getEligibleStudentIds(
  presentIds: readonly string[],
  attendanceType: AttendanceType,
  existingLogs: readonly AttendanceLogSummary[]
): string[] {
  const alreadyRecorded = new Set(
    existingLogs
      .filter(log => log.attendance_type === attendanceType && typeof log.person_id === 'string')
      .map(log => log.person_id as string)
  );

  return presentIds.filter(id => !alreadyRecorded.has(id));
}
