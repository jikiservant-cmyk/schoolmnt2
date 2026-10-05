import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';
import { normalizeSerial } from '@/lib/tenant';
import { consumeRateLimit, isRateLimited } from '@/lib/security/rate-limit';
import type { DeviceAdapter, DeviceRecord } from '@/lib/devices/types';

/**
 * Shared hardening for every hardware-facing endpoint
 * (/iclock/cdata, /iclock/getrequest, /iclock/devicecmd, /api/devices/push).
 */

/** Largest request body a device may send (ATTLOG batches are a few KB). */
export const MAX_DEVICE_BODY_BYTES = 1024 * 1024;
/** Failed authentications allowed per client IP per window before 429. */
const AUTH_FAIL_LIMIT = 20;
const AUTH_FAIL_IP_LIMIT = 100;
const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000;

export function deviceClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim().slice(0, 64) || 'unknown';
  return (req.headers.get('x-real-ip') || 'unknown').slice(0, 64);
}

/**
 * Reads the body but refuses anything larger than `maxBytes`. Previously
 * routes called `req.text()` with no limit, even before authenticating.
 */
export async function readDeviceBody(req: Request, maxBytes = MAX_DEVICE_BODY_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export function payloadTooLarge() {
  return new NextResponse('ERROR: PAYLOAD_TOO_LARGE', { status: 413, headers: { 'Content-Type': 'text/plain' } });
}

export type DeviceAuthResult =
  | { ok: true; device: DeviceRecord; adapter: DeviceAdapter; supabase: ReturnType<typeof createAdminClient>; serial: string }
  | { ok: false; response: NextResponse };

/**
 * One authentication path for all device endpoints.
 * - Every failure returns the same generic 401, so attackers can't tell an
 *   unknown serial, a deactivated device and a wrong secret apart.
 * - Failed attempts are throttled per client IP (429 + Retry-After).
 *   Successful devices are never throttled, and limits are per IP rather
 *   than per serial, so an attacker can't lock a real device out.
 */
export async function authenticateDeviceRequest(req: Request, rawSerial: unknown, route: string): Promise<DeviceAuthResult> {
  const ip = deviceClientIp(req);
  const serialKey = typeof rawSerial === 'string' ? rawSerial.trim().toUpperCase().slice(0, 64) : '-';
  // Two buckets: per IP+serial (stops guessing one device's secret) and per IP
  // (stops spraying many serials). Behind a shared NAT, one misconfigured
  // terminal can't lock out the school's other devices.
  const failKey = `device-auth-fail:${ip}:${serialKey}`;
  const ipKey = `device-auth-fail-ip:${ip}`;
  if (isRateLimited(failKey, AUTH_FAIL_LIMIT) || isRateLimited(ipKey, AUTH_FAIL_IP_LIMIT)) {
    return { ok: false, response: new NextResponse('ERROR: TOO_MANY_ATTEMPTS', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '600' } }) };
  }

  const fail = (reason: string) => {
    consumeRateLimit(failKey, AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW_MS);
    consumeRateLimit(ipKey, AUTH_FAIL_IP_LIMIT, AUTH_FAIL_WINDOW_MS);
    console.warn(`[Device Gateway] ${route} rejected (ip ${ip}): ${reason}`);
    return { ok: false as const, response: new NextResponse('ERROR: UNAUTHORIZED', { status: 401, headers: { 'Content-Type': 'text/plain' } }) };
  };

  const serial = normalizeSerial(rawSerial);
  if (!serial) return fail('missing or malformed serial');

  const supabase = createAdminClient();
  const { data: rawDevice, error } = await supabase
    .from('devices')
    .select('*')
    .eq('serial_number', serial)
    .maybeSingle();

  if (error) {
    console.error(`[Device Gateway] device lookup failed for ${serial}:`, error.message);
    return { ok: false, response: new NextResponse('ERROR: TEMPORARILY_UNAVAILABLE', { status: 503, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }) };
  }
  if (!rawDevice) return fail(`unknown serial ${serial}`);
  if (!rawDevice.is_active) return fail(`deactivated device ${serial}`);

  const device = parseDeviceMetadata(rawDevice);
  const adapter = getDeviceAdapter(device.device_type);
  const authorized = await adapter.buildAuthCheck(req, device);
  if (!authorized) return fail(`bad secret for ${serial}`);

  return { ok: true, device, adapter, supabase, serial };
}

/** Commands are sent as `C:<id>:<text>` lines; CR/LF inside text would smuggle extra commands. */
export function isSafeDeviceCommand(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0 && !/[\r\n\0]/.test(text) && text.length <= 4096;
}
