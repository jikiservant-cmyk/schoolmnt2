/**
 * SMS wallet helpers shared by the dashboard, the top-up action and the
 * payment webhook.
 *
 * A school's wallet lives in public.wallets and may be linked by tenant_id
 * and/or school_id. Older code could create duplicate wallets (double-click on
 * "Top up"), and `.or(...).maybeSingle()` then failed and silently showed or
 * credited the wrong balance. Every reader and writer now picks the SAME
 * wallet, with the same rule as school.apply_payment() in
 * supabase_migrations/05_sms_payment_integrity.sql:
 *   tenant_id match first, then the highest balance, then id.
 */
import { UUID_RE } from '@/lib/tenant';

export interface WalletRow {
  id: string;
  balance: number | string | null;
  tenant_id?: string | null;
  school_id?: string | null;
}

export function pickSchoolWallet<T extends WalletRow>(rows: T[] | null | undefined, schoolId: string): T | null {
  if (!rows || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const ta = a.tenant_id === schoolId ? 1 : 0;
    const tb = b.tenant_id === schoolId ? 1 : 0;
    if (ta !== tb) return tb - ta;
    const ba = Number(a.balance ?? -Infinity);
    const bb = Number(b.balance ?? -Infinity);
    if (ba !== bb) return bb - ba;
    return String(a.id).localeCompare(String(b.id));
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
