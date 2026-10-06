import { NextRequest, NextResponse } from 'next/server';
import { processAttendanceEvents } from '@/lib/devices/processor';
import { authenticateDeviceRequest, readDeviceBody } from '@/lib/devices/gateway';

export const dynamic = 'force-dynamic';

function serialFromRequest(req: NextRequest, rawBody?: string): unknown {
  const url = new URL(req.url);
  const sn =
    url.searchParams.get('sn') ||
    url.searchParams.get('SN') ||
    url.searchParams.get('serial') ||
    url.searchParams.get('device_id') ||
    req.headers.get('x-device-sn') ||
    req.headers.get('x-serial-number');
  if (sn || !rawBody) return sn;
  try {
    const p = JSON.parse(rawBody);
    return p.serialNumber || p.serial_number || p.sn || p.SN || p.terminal_id || p.deviceId || p.AccessControllerEvent?.serialNo;
  } catch {
    return null;
  }
}

const jsonError = (error: string, status: number, headers?: Record<string, string>) =>
  NextResponse.json({ error }, { status, headers });

async function authFailureAsJson(res: NextResponse) {
  const map: Record<number, string> = { 401: 'Invalid device credentials', 429: 'Too many failed attempts', 503: 'Temporarily unavailable' };
  const retry = res.headers.get('Retry-After');
  return jsonError(map[res.status] || 'Unauthorized', res.status, retry ? { 'Retry-After': retry } : undefined);
}

// GET: probe / handshake / health check
export async function GET(req: NextRequest) {
  const auth = await authenticateDeviceRequest(req, serialFromRequest(req), 'push GET');
  if (!auth.ok) return authFailureAsJson(auth.response);
  const { device, adapter, supabase } = auth;

  supabase.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id).then(() => undefined);

  const handshake = adapter.buildHandshakeResponse(device);
  let body: unknown = handshake.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* plain-text handshake */ }
  }
  return NextResponse.json({
    status: 'online',
    device: { serial_number: device.serial_number, label: device.label, protocol: device.device_type, adapter: adapter.displayName },
    handshake: body,
  });
}

// POST: universal push ingestion
export async function POST(req: NextRequest) {
  // The serial may be inside the JSON body, so read it first, but with a
  // hard size cap (it used to read unlimited bodies before authenticating).
  const rawBody = await readDeviceBody(req);
  if (rawBody === null) return jsonError('Payload too large', 413);

  const auth = await authenticateDeviceRequest(req, serialFromRequest(req, rawBody), 'push POST');
  if (!auth.ok) return authFailureAsJson(auth.response);
  const { device, adapter, supabase } = auth;

  supabase.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id).then(() => undefined);

  const events = await adapter.parseIncomingPush(rawBody, req.headers, new URL(req.url), device);
  let stats = { totalReceived: events.length, insertedAttendanceLogs: 0, queuedSmsCount: 0, skippedDuplicates: 0 };
  if (events.length > 0) {
    try {
      const r = await processAttendanceEvents(events, device);
      stats = { totalReceived: r.totalReceived, insertedAttendanceLogs: r.insertedAttendanceLogs, queuedSmsCount: r.queuedSmsCount, skippedDuplicates: r.skippedDuplicates };
    } catch (err) {
      console.error(`[Device Push] Failed to store events from ${device.serial_number}:`, err instanceof Error ? err.message : err);
      return jsonError('Could not store events, retry later', 503, { 'Retry-After': '60' });
    }
  }
  return NextResponse.json({ success: true, message: `Processed ${events.length} event(s) using ${adapter.displayName}`, stats });
}
