import { createAdminClient } from '@/utils/supabase/admin';

/**
 * Tenant-ownership assertions.
 *
 * Most server actions use the service-role client (which BYPASSES Postgres
 * RLS). Every foreign identifier that arrives from the browser — class IDs,
 * person IDs, device IDs/serials, teacher IDs — must therefore be proven to
 * belong to the caller's school before it is read, written or referenced.
 * Without this, a school admin can attach their records to another school's
 * rows (cross-tenant references) or read another school's data through joins.
 *
 * All helpers fail CLOSED: any lookup error is treated as "not owned".
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Device serials: uppercase alphanumerics plus . _ - (matched with .eq, never .ilike)
export const SERIAL_RE = /^[A-Z0-9._-]{1,64}$/;

type Admin = ReturnType<typeof createAdminClient>;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function normalizeSerial(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim().toUpperCase();
  return SERIAL_RE.test(clean) ? clean : null;
}

/** Returns the class row if it belongs to `schoolId`, else null. */
export async function getOwnedClass(admin: Admin, schoolId: string, classId: unknown) {
  if (!isUuid(classId)) return null;
  const { data, error } = await admin
    .from('classes')
    .select('id, name, school_id')
    .eq('id', classId)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (error || !data) return null;
  return data as { id: string; name: string; school_id: string };
}

/** True only if EVERY id is a class owned by `schoolId`. Empty list => true. */
export async function allClassesOwned(admin: Admin, schoolId: string, classIds: unknown): Promise<boolean> {
  if (!Array.isArray(classIds)) return false;
  if (classIds.length === 0) return true;
  if (classIds.length > 200 || !classIds.every(isUuid)) return false;
  const unique = Array.from(new Set(classIds as string[]));
  const { data, error } = await admin
    .from('classes')
    .select('id')
    .eq('school_id', schoolId)
    .in('id', unique);
  if (error || !data) return false;
  return data.length === unique.length;
}

/** Returns the person if they belong to `schoolId` (optionally with one of `roles`). */
export async function getOwnedPerson(
  admin: Admin,
  schoolId: string,
  personId: unknown,
  roles?: string[]
) {
  if (!isUuid(personId)) return null;
  const { data, error } = await admin
    .from('people')
    .select('id, full_name, role, school_id, class_id, is_active, device_user_id')
    .eq('id', personId)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (error || !data) return null;
  if (roles && !roles.includes(data.role)) return null;
  return data as {
    id: string; full_name: string; role: string; school_id: string;
    class_id: string | null; is_active: boolean | null; device_user_id: string | null;
  };
}

/** Resolve a device by serial strictly inside `schoolId` (exact match, no wildcards). */
export async function getOwnedDeviceBySerial(admin: Admin, schoolId: string, serial: unknown) {
  const clean = normalizeSerial(serial);
  if (!clean) return null;
  const { data, error } = await admin
    .from('devices')
    .select('*')
    .eq('school_id', schoolId)
    .eq('serial_number', clean)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}
