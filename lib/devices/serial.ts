/** Normalize hardware serials before exact, case-normalized database lookup. */
export function normalizeDeviceSerialNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const serial = value.trim().toUpperCase();
  if (!serial || serial.length > 128 || !/^[A-Z0-9._:-]+$/.test(serial)) return null;
  return serial;
}
