/**
 * Queue paid SMS rows in school.notifications, at most one attendance SMS per
 * child, per direction (check_in / check_out), per local day.
 *
 * Each SMS costs the school money once the Edge Function sends it. Before this
 * helper, the kiosk, the class register and the biometric device each did
 * "look for today's record, then insert": simultaneous taps or submissions all
 * passed the look-up and queued (and paid for) several SMS. Migration 06 adds a
 * UNIQUE (school_id, dedupe_key) index; this helper sets the key and treats a
 * conflict as "already queued". It also stops the same child getting two SMS
 * for one direction because two different paths (device + register) fired.
 *
 * Callers pass a service-role client (school schema).
 */

type Row = Record<string, unknown>;
// Supabase client typing varies per call site; only .from().insert() is used.
type InsertClient = { from: (table: string) => { insert: (values: Row | Row[]) => PromiseLike<{ error: { code?: string; message?: string } | null }> } };

const DAY_FMT = new Map<string, Intl.DateTimeFormat>();

/** 'att:<personId>:<check_in|check_out>:<YYYY-MM-DD in the school timezone>' */
export function attendanceSmsKey(personId: string, attendanceType: string, at: Date, timeZone = 'Africa/Kampala'): string {
  let fmt = DAY_FMT.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    DAY_FMT.set(timeZone, fmt);
  }
  return `att:${personId}:${attendanceType}:${fmt.format(at)}`;
}

const isUniqueViolation = (e: { code?: string } | null) => !!e && e.code === '23505';
const isMissingDedupeColumn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42703' || e.code === 'PGRST204') && /dedupe_key/.test(e.message || '');

let warnedLegacy = false;

/**
 * Insert notification rows (each may carry `dedupe_key`). Returns how many were
 * queued and how many were skipped as already queued. Throws on other errors.
 */
export async function queueNotifications(client: InsertClient, rows: Row[]): Promise<{ queued: number; duplicates: number }> {
  if (rows.length === 0) return { queued: 0, duplicates: 0 };

  const { error } = await client.from('notifications').insert(rows);
  if (!error) return { queued: rows.length, duplicates: 0 };

  if (isMissingDedupeColumn(error)) {
    // Database without migration 06: queue without the guard (old behaviour).
    if (!warnedLegacy) {
      warnedLegacy = true;
      console.warn('[SMS queue] school.notifications.dedupe_key missing: run supabase_migrations/06_money_lockdown.sql (duplicate SMS are possible until then).');
    }
    const legacy = rows.map(({ dedupe_key: _k, ...r }) => r);
    const { error: e2 } = await client.from('notifications').insert(legacy);
    if (e2) throw new Error(`notifications insert failed: ${e2.message}`);
    return { queued: legacy.length, duplicates: 0 };
  }

  if (!isUniqueViolation(error)) throw new Error(`notifications insert failed: ${error.message}`);

  // Some rows were already queued: insert one by one, skipping duplicates.
  let queued = 0;
  let duplicates = 0;
  for (const row of rows) {
    const { error: rowErr } = await client.from('notifications').insert(row);
    if (!rowErr) queued++;
    else if (isUniqueViolation(rowErr)) duplicates++;
    else throw new Error(`notifications insert failed: ${rowErr.message}`);
  }
  return { queued, duplicates };
}
