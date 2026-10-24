/**
 * SMS wallet helpers shared by the dashboard, the top-up action and the
 * payment webhook.
 *
 * A school's wallet lives in public.wallets and may be linked by tenant_id
 * and/or school_id. Older code could create duplicate wallets (double-click on
 * "Top up"), and `.or(...).maybeSingle()` then failed and silently showed or
 * credited the wrong balance. Every reader and writer now picks the SAME
 * wallet, with the exact same rule as school.apply_payment() in
 * supabase_migrations/11_round13_money_integrity.sql:
 *   single-tenant row only -> tenant_id match first -> highest non-null finite balance -> ASCII id.
 */
import { UUID_RE } from '@/lib/tenant';

export interface WalletRow {
  id: string;
  balance: number | string | null;
  tenant_id?: string | null;
  school_id?: string | null;
}

function walletBalanceSortKey(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === '') return -Infinity;
  const n = Number(v);
  return Number.isFinite(n) ? n : -Infinity;
}

export function pickSchoolWallet<T extends WalletRow>(rows: T[] | null | undefined, schoolId: string): T | null {
  if (!rows || rows.length === 0 || !UUID_RE.test(schoolId)) return null;
  const sid = schoolId.toLowerCase();
  const valid = rows.filter((r) => {
    const tid = typeof r.tenant_id === 'string' && r.tenant_id ? r.tenant_id.toLowerCase() : null;
    const rid = typeof r.school_id === 'string' && r.school_id ? r.school_id.toLowerCase() : null;
    // Never accept a corrupted hybrid wallet row linking two different tenants
    return (tid === sid && (rid === null || rid === sid)) || (rid === sid && tid === null);
  });
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => {
    const ta = a.tenant_id?.toLowerCase() === sid ? 1 : 0;
    const tb = b.tenant_id?.toLowerCase() === sid ? 1 : 0;
    if (ta !== tb) return tb - ta;
    const ba = walletBalanceSortKey(a.balance);
    const bb = walletBalanceSortKey(b.balance);
    if (ba !== bb) return bb - ba;
    const ida = String(a.id);
    const idb = String(b.id);
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });
  return sorted[0];
}

/** Load the school's wallet (or null). Never throws on duplicates. */
export async function loadSchoolWallet(publicAdmin: any, schoolId: string): Promise<WalletRow | null> {
  if (!UUID_RE.test(schoolId)) return null;
  const { data, error } = await publicAdmin
    .from('wallets')
    .select('id, balance, tenant_id, school_id')
    .or(`tenant_id.eq.${schoolId},school_id.eq.${schoolId}`)
    .limit(20);
  if (error) throw new Error(`wallet lookup failed: ${error.message}`);
  return pickSchoolWallet(data as WalletRow[], schoolId);
}

/** PostgREST / Postgres "function does not exist" (migration not applied yet). */
export function isMissingFunction(err: { code?: string } | null | undefined): boolean {
  return !!err && (err.code === 'PGRST202' || err.code === '42883');
}

/** PostgREST / Postgres "table does not exist" (migration not applied yet). */
export function isMissingTable(err: { code?: string } | null | undefined): boolean {
  return !!err && (err.code === 'PGRST205' || err.code === '42P01');
}

/**
 * May the legacy school.schools.settings.balance still be shown / carried over?
 * Never once `settings.wallet_migrated === true` OR once any credit exists in
 * `school.payment_events`. Only missing pre-migration-05 `payment_events` table
 * permits fallback; transient DB errors fail CLOSED (`false`) so spent money
 * is never resurrected.
 */
export async function legacyBalanceUsable(
  schoolAdmin: any,
  schoolId: string,
  settings?: Record<string, any> | null
): Promise<boolean> {
  if (settings && settings.wallet_migrated === true) return false;
  const { data, error } = await schoolAdmin
    .from('payment_events')
    .select('id')
    .eq('school_id', schoolId)
    .eq('outcome', 'credited')
    .limit(1);
  if (error) {
    return isMissingTable(error);
  }
  return !data || data.length === 0;
}
