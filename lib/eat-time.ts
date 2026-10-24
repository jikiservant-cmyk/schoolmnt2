/**
 * Centralized School Local Time utility functions (defaults to East Africa Time
 * `Africa/Kampala`, while supporting any school-configured IANA timezone with
 * zero hardcoded `+03:00` assumptions).
 *
 * All data in PostgreSQL is stored as standard UTC `timestamptz`.
 */

export const EAT_TIMEZONE = 'Africa/Kampala';

/**
 * Resolves exact UTC `Date` for a local wall-clock timestamp in any IANA `timeZone`
 * (handles UTC offsets and DST transitions accurately without external dependencies).
 */
export function wallClockToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
  ms = 0,
  timeZone: string = EAT_TIMEZONE
): Date {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  let guess = targetAsUtc;

  for (let i = 0; i < 2; i++) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date(guess));
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
    const localAsUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
      ms
    );
    guess += targetAsUtc - localAsUtc;
  }

  return new Date(guess);
}

/**
 * Parses a raw wall-clock string ("YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS")
 * in a school's IANA timezone into an exact `Date` object.
 */
export function parseLocalDateTimeInZone(
  datetimeStr: string,
  timeZone: string = EAT_TIMEZONE
): Date {
  if (!datetimeStr) return new Date();
  const trimmed = datetimeStr.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (m) {
    return wallClockToDate(
      parseInt(m[1], 10),
      parseInt(m[2], 10),
      parseInt(m[3], 10),
      parseInt(m[4], 10),
      parseInt(m[5], 10),
      m[6] ? parseInt(m[6], 10) : 0,
      m[7] ? parseInt(m[7].padEnd(3, '0'), 10) : 0,
      timeZone
    );
  }
  return new Date(trimmed);
}

/**
 * Returns formatted time in the school's timezone (defaults to Africa/Kampala).
 * Example: "08:15 AM" or "08:15:30 AM"
 */
export function formatEATTime(
  dateInput?: string | number | Date | null,
  options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  },
  timeZone: string = EAT_TIMEZONE
): string {
  if (!dateInput) return '—';
  try {
    const d = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('en-US', {
      timeZone,
      ...options,
    });
  } catch (err) {
    console.error('formatEATTime error:', err);
    return '—';
  }
}

/**
 * Returns formatted date in the school's timezone (defaults to Africa/Kampala).
 * Example: "Monday, Aug 17, 2026" or "Aug 17, 2026"
 */
export function formatEATDate(
  dateInput?: string | number | Date | null,
  options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  },
  timeZone: string = EAT_TIMEZONE
): string {
  if (!dateInput) return '—';
  try {
    const d = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', {
      timeZone,
      ...options,
    });
  } catch (err) {
    console.error('formatEATDate error:', err);
    return '—';
  }
}

/**
 * Returns formatted Date and Time together in the school's timezone.
 * Example: "Aug 17, 2026, 08:15 AM"
 */
export function formatEATDateTime(
  dateInput?: string | number | Date | null,
  options?: { showSeconds?: boolean; timeZone?: string }
): string {
  if (!dateInput) return '—';
  try {
    const d = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', {
      timeZone: options?.timeZone || EAT_TIMEZONE,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: options?.showSeconds ? '2-digit' : undefined,
      hour12: true,
    });
  } catch (err) {
    console.error('formatEATDateTime error:', err);
    return '—';
  }
}

/**
 * Extracts standard YYYY-MM-DD date key in the school's timezone.
 * Accurately handles midnight boundaries (e.g. 22:30 UTC -> 01:30 EAT next day).
 */
export function getEATDateKey(
  dateInput?: string | number | Date | null,
  timeZone: string = EAT_TIMEZONE
): string {
  if (!dateInput) {
    dateInput = new Date();
  }
  try {
    const d = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
    if (isNaN(d.getTime())) return 'unknown';

    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(d);
  } catch {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }
}

/**
 * Returns UTC ISO strings for the start and end of any day in the school's timezone
 * for database queries: `.gte('occurred_at', startIso).lte('occurred_at', endIso)`.
 */
export function getEATDayRange(
  dateInput?: string | number | Date | null,
  timeZone: string = EAT_TIMEZONE
): {
  startIso: string;
  endIso: string;
  dateStr: string;
  label: string;
} {
  const dateStr =
    typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())
      ? dateInput.trim()
      : getEATDateKey(dateInput, timeZone);

  const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10));
  const startDate = wallClockToDate(y, m, d, 0, 0, 0, 0, timeZone);
  const endDate = wallClockToDate(y, m, d, 23, 59, 59, 999, timeZone);

  const label = startDate.toLocaleDateString('en-US', {
    timeZone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return {
    startIso: startDate.toISOString(),
    endIso: endDate.toISOString(),
    dateStr,
    label,
  };
}

/**
 * Returns current hour (0 - 23) in the school's timezone.
 */
export function getEATCurrentHour(
  date: Date = new Date(),
  timeZone: string = EAT_TIMEZONE
): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(date), 10) % 24;
  } catch {
    return (date.getUTCHours() + 3) % 24;
  }
}

/**
 * Returns dynamic greeting based on current local time.
 */
export function getEATGreeting(
  date: Date = new Date(),
  timeZone: string = EAT_TIMEZONE
): string {
  const hour = getEATCurrentHour(date, timeZone);
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Returns formatted date in uppercase header style (e.g. MONDAY · 17 AUGUST 2026).
 */
export function getEATFormattedDateHeader(
  date: Date = new Date(),
  timeZone: string = EAT_TIMEZONE
): string {
  try {
    return date
      .toLocaleDateString('en-US', {
        timeZone,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
      .toUpperCase()
      .replace(',', ' ·');
  } catch {
    return 'TODAY';
  }
}

/**
 * Converts a raw device local time string ("YYYY-MM-DD HH:MM:SS") from terminal
 * into a standard UTC ISO string using the school/device timezone.
 */
export function parseDeviceEATTimeString(
  datetimeStr: string,
  timeZone: string = EAT_TIMEZONE
): string {
  if (!datetimeStr) return new Date().toISOString();
  try {
    const parsed = parseLocalDateTimeInZone(datetimeStr, timeZone);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    return new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}
