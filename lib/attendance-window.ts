/**
 * Utility functions for verifying attendance SMS dispatch windows.
 * All time restrictions are evaluated in East Africa Time (EAT, UTC+3 / Africa/Kampala).
 *
 * Rules:
 * - Morning Check-in: 05:00 AM to 09:00 AM EAT
 * - Evening Check-out: 04:00 PM to 10:00 PM EAT (16:00 to 22:00)
 */

export interface AttendanceSmsWindowResult {
  allowed: boolean;
  reason?: string;
  eatTimeStr: string;
}

export function isWithinAttendanceSmsWindow(
  attendanceType: 'check_in' | 'check_out',
  date: Date = new Date(),
  timeZone: string = 'Africa/Kampala'
): AttendanceSmsWindowResult {
  try {
    // Extract hour & minute formatted specifically in the school/EAT timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    const totalMinutes = hour * 60 + minute;

    const displayTime = date.toLocaleTimeString('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

    if (attendanceType === 'check_in') {
      // 05:00 AM (300 mins) to 09:00 AM (540 mins)
      const minMins = 5 * 60;   // 05:00
      const maxMins = 9 * 60;   // 09:00

      if (totalMinutes >= minMins && totalMinutes <= maxMins) {
        return { allowed: true, eatTimeStr: displayTime };
      }

      return {
        allowed: false,
        reason: `Morning check-in SMS is only sent between 05:00 AM and 09:00 AM EAT. Current time is ${displayTime} EAT.`,
        eatTimeStr: displayTime,
      };
    } else if (attendanceType === 'check_out') {
      // 04:00 PM (960 mins) to 10:00 PM (1320 mins)
      const minMins = 16 * 60;  // 16:00 (4:00 PM)
      const maxMins = 22 * 60;  // 22:00 (10:00 PM)

      if (totalMinutes >= minMins && totalMinutes <= maxMins) {
        return { allowed: true, eatTimeStr: displayTime };
      }

      return {
        allowed: false,
        reason: `Evening check-out SMS is only sent between 04:00 PM and 10:00 PM EAT. Current time is ${displayTime} EAT.`,
        eatTimeStr: displayTime,
      };
    }

    return {
      allowed: false,
      reason: `Unknown attendance type: ${attendanceType}`,
      eatTimeStr: displayTime,
    };
  } catch (error: any) {
    console.error('Error calculating EAT attendance window:', error);
    // Fallback safe: if timezone fails, allow or use UTC+3 offset
    return {
      allowed: true,
      eatTimeStr: date.toISOString(),
    };
  }
}

/**
 * Determines the status for a morning check-in based on the time in EAT.
 * Rules:
 * - Arriving at or before 08:00 AM EAT -> 'present'
 * - Arriving after 08:00 AM EAT -> 'late'
 */
export function getAttendanceStatusForCheckIn(
  date: Date = new Date(),
  timeZone: string = 'Africa/Kampala'
): 'present' | 'late' {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    const totalMinutes = hour * 60 + minute;

    // 8:00 AM is 8 * 60 = 480 minutes
    if (totalMinutes > 480) {
      return 'late';
    }
    return 'present';
  } catch {
    return 'present';
  }
}

/**
 * Returns the current suggested attendance window mode based on EAT time:
 * - 04:00 AM to 01:00 PM -> 'check_in' (Morning)
 * - 01:00 PM to 11:59 PM -> 'check_out' (Evening)
 */
export function getCurrentAttendanceWindowMode(
  date: Date = new Date(),
  timeZone: string = 'Africa/Kampala'
): 'check_in' | 'check_out' {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    });
    const hour = parseInt(formatter.format(date), 10);
    if (hour >= 13) {
      return 'check_out';
    }
    return 'check_in';
  } catch {
    return 'check_in';
  }
}

/**
 * Returns ISO strings for the start and end of today in East Africa Time (UTC+3)
 */
export function getEatTodayRange(
  date: Date = new Date(),
  timeZone: string = 'Africa/Kampala'
): { startIso: string; endIso: string; dateStr: string } {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // Format is YYYY-MM-DD in EAT
    const dateStr = formatter.format(date);
    // EAT is UTC+3. Start of day in EAT (00:00:00+03:00) is 21:00:00 UTC previous day.
    const startIso = new Date(`${dateStr}T00:00:00+03:00`).toISOString();
    const endIso = new Date(`${dateStr}T23:59:59.999+03:00`).toISOString();
    return { startIso, endIso, dateStr };
  } catch {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
    return {
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      dateStr: date.toISOString().slice(0, 10),
    };
  }
}

