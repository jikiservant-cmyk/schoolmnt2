/**
 * Configurable per-school attendance cutoff, session switchover, and SMS dispatch
 * window evaluation.
 *
 * Every school configures its own timezone, late cutoffs, grace period, morning
 * check-in SMS window, afternoon check-out SMS window, 24/7 mode, and session
 * switchover time in PostgreSQL (`school.school_settings`).
 */

import { getEATDayRange } from './eat-time';
import {
  DEFAULT_SCHOOL_POLICY_SETTINGS,
  formatHhMm12Hour,
  parseHhMmToMinutes,
} from './school-settings';

export interface AttendanceWindowOptions {
  timeZone?: string;
  restrictSmsWindows?: boolean;
  checkInSmsStart?: string;
  checkInSmsEnd?: string;
  checkOutSmsStart?: string;
  checkOutSmsEnd?: string;
}

export interface CheckInCutoffOptions {
  timeZone?: string;
  role?: 'student' | 'teacher' | 'support_staff' | 'admin' | string;
  studentLateCutoff?: string;
  studentGraceMinutes?: number;
  staffLateCutoff?: string;
}

export interface SwitchoverOptions {
  timeZone?: string;
  afternoonSwitchoverTime?: string;
}

export interface AttendanceSmsWindowResult {
  allowed: boolean;
  reason?: string;
  eatTimeStr: string;
}

export function isWithinAttendanceSmsWindow(
  attendanceType: 'check_in' | 'check_out',
  date: Date = new Date(),
  timeZoneOrOptions: string | AttendanceWindowOptions = DEFAULT_SCHOOL_POLICY_SETTINGS.timeZone
): AttendanceSmsWindowResult {
  const opts: AttendanceWindowOptions =
    typeof timeZoneOrOptions === 'string'
      ? { timeZone: timeZoneOrOptions }
      : timeZoneOrOptions || {};

  const timeZone = opts.timeZone || DEFAULT_SCHOOL_POLICY_SETTINGS.timeZone;
  const restrictWindows = opts.restrictSmsWindows ?? DEFAULT_SCHOOL_POLICY_SETTINGS.restrictSmsWindows;
  const inStart = opts.checkInSmsStart || DEFAULT_SCHOOL_POLICY_SETTINGS.checkInSmsStart;
  const inEnd = opts.checkInSmsEnd || DEFAULT_SCHOOL_POLICY_SETTINGS.checkInSmsEnd;
  const outStart = opts.checkOutSmsStart || DEFAULT_SCHOOL_POLICY_SETTINGS.checkOutSmsStart;
  const outEnd = opts.checkOutSmsEnd || DEFAULT_SCHOOL_POLICY_SETTINGS.checkOutSmsEnd;

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10) % 24;
    const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
    const totalMinutes = hour * 60 + minute;

    const displayTime = date.toLocaleTimeString('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

    if (attendanceType !== 'check_in' && attendanceType !== 'check_out') {
      return {
        allowed: false,
        reason: `Unknown attendance type: ${attendanceType}`,
        eatTimeStr: displayTime,
      };
    }

    if (!restrictWindows) {
      return { allowed: true, eatTimeStr: displayTime };
    }

    if (attendanceType === 'check_in') {
      const minMins = parseHhMmToMinutes(inStart, 5 * 60);
      const maxMins = parseHhMmToMinutes(inEnd, 9 * 60);

      if (totalMinutes >= minMins && totalMinutes <= maxMins) {
        return { allowed: true, eatTimeStr: displayTime };
      }

      return {
        allowed: false,
        reason: `Morning check-in SMS is configured between ${formatHhMm12Hour(inStart)} and ${formatHhMm12Hour(inEnd)} (${timeZone}). Current time is ${displayTime}.`,
        eatTimeStr: displayTime,
      };
    }

    const minMins = parseHhMmToMinutes(outStart, 16 * 60);
    const maxMins = parseHhMmToMinutes(outEnd, 22 * 60);

    if (totalMinutes >= minMins && totalMinutes <= maxMins) {
      return { allowed: true, eatTimeStr: displayTime };
    }

    return {
      allowed: false,
      reason: `Check-out SMS is configured between ${formatHhMm12Hour(outStart)} and ${formatHhMm12Hour(outEnd)} (${timeZone}). Current time is ${displayTime}.`,
      eatTimeStr: displayTime,
    };
  } catch (error) {
    console.error('Error calculating school attendance SMS window:', error);
    return {
      allowed: true,
      eatTimeStr: date.toISOString(),
    };
  }
}

/**
 * Determines `present` vs `late` for a check-in according to the school's
 * configured student cutoff (+ grace period) or staff cutoff in the school's timezone.
 */
export function getAttendanceStatusForCheckIn(
  date: Date = new Date(),
  timeZoneOrOptions: string | CheckInCutoffOptions = DEFAULT_SCHOOL_POLICY_SETTINGS.timeZone
): 'present' | 'late' {
  const opts: CheckInCutoffOptions =
    typeof timeZoneOrOptions === 'string'
      ? { timeZone: timeZoneOrOptions }
      : timeZoneOrOptions || {};

  const timeZone = opts.timeZone || DEFAULT_SCHOOL_POLICY_SETTINGS.timeZone;
  const isStaff = opts.role === 'teacher' || opts.role === 'support_staff' || opts.role === 'admin';
  const baseCutoffMins = isStaff
    ? parseHhMmToMinutes(opts.staffLateCutoff || DEFAULT_SCHOOL_POLICY_SETTINGS.staffLateCutoff, 8 * 60 + 30)
    : parseHhMmToMinutes(opts.studentLateCutoff || DEFAULT_SCHOOL_POLICY_SETTINGS.studentLateCutoff, 8 * 60) +
      Math.max(0, Math.min(60, Math.trunc(opts.studentGraceMinutes ?? DEFAULT_SCHOOL_POLICY_SETTINGS.studentGraceMinutes)));

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10) % 24;
    const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
    const totalMinutes = hour * 60 + minute;

    return totalMinutes > baseCutoffMins ? 'late' : 'present';
  } catch {
    return 'present';
  }
}

/**
 * Returns the suggested attendance window mode (`check_in` vs `check_out`)
 * based on the school's configured afternoon switchover time.
 */
export function getCurrentAttendanceWindowMode(
  date: Date = new Date(),
  timeZoneOrOptions: string | SwitchoverOptions = DEFAULT_SCHOOL_POLICY_SETTINGS.timeZone
): 'check_in' | 'check_out' {
  const opts: SwitchoverOptions =
    typeof timeZoneOrOptions === 'string'
      ? { timeZone: timeZoneOrOptions }
      : timeZoneOrOptions || {};

  const timeZone = opts.timeZone || DEFAULT_SCHOOL_POLICY_SETTINGS.timeZone;
  const switchoverMins = parseHhMmToMinutes(
    opts.afternoonSwitchoverTime || DEFAULT_SCHOOL_POLICY_SETTINGS.afternoonSwitchoverTime,
    13 * 60
  );

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10) % 24;
    const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
    return hour * 60 + minute >= switchoverMins ? 'check_out' : 'check_in';
  } catch {
    return 'check_in';
  }
}

/**
 * Returns ISO strings for the start and end of today in the school's timezone.
 */
export function getEatTodayRange(
  date: Date = new Date(),
  timeZone: string = DEFAULT_SCHOOL_POLICY_SETTINGS.timeZone
): { startIso: string; endIso: string; dateStr: string } {
  const { startIso, endIso, dateStr } = getEATDayRange(date, timeZone);
  return { startIso, endIso, dateStr };
}
