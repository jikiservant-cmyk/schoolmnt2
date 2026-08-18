/**
 * Centralized East Africa Time (EAT, UTC+3 / Africa/Kampala) utility functions.
 * All data in the Supabase PostgreSQL database is stored as standard UTC timestamps.
 * This module ensures consistent application-level conversion, querying, and rendering in EAT.
 */

export const EAT_TIMEZONE = 'Africa/Kampala';

/**
 * Returns formatted time in EAT (Africa/Kampala, UTC+3).
 * Example: "08:15 AM" or "08:15:30 AM"
 */
export function formatEATTime(
  dateInput?: string | number | Date | null,
  options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }
): string {
  if (!dateInput) return '—';
  try {
    const d = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('en-US', {
      timeZone: EAT_TIMEZONE,
      ...options,
    });
  } catch (err) {
    console.error('formatEATTime error:', err);
    return '—';
  }
}

/**
 * Returns formatted date in EAT (Africa/Kampala, UTC+3).
 * Example: "Monday, Aug 17, 2026" or "Aug 17, 2026"
 */
export function formatEATDate(
  dateInput?: string | number | Date | null,
  options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }
): string {
  if (!dateInput) return '—';
  try {
    const d = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', {
      timeZone: EAT_TIMEZONE,
      ...options,
    });
  } catch (err) {
    console.error('formatEATDate error:', err);
    return '—';
  }
}

/**
 * Returns formatted Date and Time together in EAT.
 * Example: "Aug 17, 2026, 08:15 AM"
 */
export function formatEATDateTime(
  dateInput?: string | number | Date | null,
  options?: { showSeconds?: boolean }
): string {
  if (!dateInput) return '—';
  try {
    const d = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', {
      timeZone: EAT_TIMEZONE,
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
 * Extracts standard YYYY-MM-DD date key in East Africa Time (UTC+3).
 * Accurately handles boundary times (e.g. 22:30 UTC -> 01:30 EAT next day).
 */
export function getEATDateKey(dateInput?: string | number | Date | null): string {
  if (!dateInput) {
    dateInput = new Date();
  }
  try {
    const d = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
    if (isNaN(d.getTime())) return 'unknown';

    // Format strictly in Africa/Kampala as YYYY-MM-DD
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: EAT_TIMEZONE,
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
 * Returns UTC ISO strings for the start and end of any day in East Africa Time (UTC+3)
 * For database queries: .gte('occurred_at', startIso).lte('occurred_at', endIso)
 */
export function getEATDayRange(dateInput?: string | number | Date | null): {
  startIso: string;
  endIso: string;
  dateStr: string;
  label: string;
} {
  const dateStr = getEATDateKey(dateInput);
  // EAT is UTC+3. Start of day in EAT (00:00:00+03:00) is 21:00:00 UTC previous day.
  const startDate = new Date(`${dateStr}T00:00:00+03:00`);
  const endDate = new Date(`${dateStr}T23:59:59.999+03:00`);

  const label = startDate.toLocaleDateString('en-US', {
    timeZone: EAT_TIMEZONE,
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
 * Returns current hour (0 - 23) in East Africa Time.
 */
export function getEATCurrentHour(date: Date = new Date()): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: EAT_TIMEZONE,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(date), 10);
  } catch {
    return date.getUTCHours() + 3;
  }
}

/**
 * Returns dynamic greeting based on current EAT time.
 */
export function getEATGreeting(date: Date = new Date()): string {
  const hour = getEATCurrentHour(date);
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Returns formatted date in uppercase Apple style in EAT (e.g. MONDAY · 17 AUGUST 2026).
 */
export function getEATFormattedDateHeader(date: Date = new Date()): string {
  try {
    return date
      .toLocaleDateString('en-US', {
        timeZone: EAT_TIMEZONE,
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
 * Converts a raw device local time string ("YYYY-MM-DD HH:MM:SS") from terminal into standard UTC ISO string
 * assuming terminal clock is set to East Africa Time (UTC+3).
 */
export function parseDeviceEATTimeString(datetimeStr: string): string {
  if (!datetimeStr) return new Date().toISOString();
  try {
    const cleaned = datetimeStr.trim().replace(' ', 'T');
    if (cleaned.includes('+') || cleaned.endsWith('Z')) {
      return new Date(cleaned).toISOString();
    }
    // Append EAT offset +03:00
    const eatIso = new Date(`${cleaned}+03:00`);
    if (!isNaN(eatIso.getTime())) {
      return eatIso.toISOString();
    }
    return new Date(datetimeStr).toISOString();
  } catch {
    return new Date().toISOString();
  }
}
