import { NextRequest, NextResponse } from 'next/server';
import { processAttendanceEvents } from '@/lib/devices/processor';
import { authenticateDeviceRequest, readDeviceBody, payloadTooLarge } from '@/lib/devices/gateway';

export const dynamic = 'force-dynamic';

const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new NextResponse(body, { status, headers: { 'Content-Type': 'text/plain', ...headers } });

const serialFrom = (req: NextRequest) => {
  const sp = new URL(req.url).searchParams;
  return sp.get('SN') || sp.get('sn') || req.headers.get('x-device-sn');
};

// Only these upload tables carry punches. OPERLOG, USERINFO, BIODATA,
// ATTPHOTO etc. are acknowledged but never parsed as attendance.
const ATTENDANCE_TABLES = new Set(['', 'ATTLOG']);

// 1. Initial handshake / config negotiation (ADMS GET)
export async function GET(req: NextRequest) {
  const auth = await authenticateDeviceRequest(req, serialFrom(req), 'cdata GET');
  if (!auth.ok) return auth.response;
  const { device, adapter, supabase } = auth;

  await supabase.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id);

  const handshake = adapter.buildHandshakeResponse(device);
  const body = typeof handshake.body === 'string' ? handshake.body : JSON.stringify(handshake.body);
  return new NextResponse(body, {
    status: handshake.status || 200,
    headers: { 'Content-Type': handshake.contentType, ...(handshake.headers || {}) },
  });
}

// 2. Data push (attendance logs, realtime punches)
export async function POST(req: NextRequest) {
  const auth = await authenticateDeviceRequest(req, serialFrom(req), 'cdata POST');
  if (!auth.ok) return auth.response;
  const { device, adapter, supabase } = auth;

  const rawBody = await readDeviceBody(req);
  if (rawBody === null) return payloadTooLarge();

  const sp = new URL(req.url).searchParams;
  const table = (sp.get('table') || sp.get('TABLE') || '').toUpperCase();

  supabase.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id).then(() => undefined);

  if (!ATTENDANCE_TABLES.has(table)) {
    // Acknowledge so the terminal doesn't resend, but don't treat it as punches.
    return text('OK');
  }

  const events = await adapter.parseIncomingPush(rawBody, req.headers, new URL(req.url), device);
  if (events.length > 0) {
    try {
      await processAttendanceEvents(events, device);
    } catch (err) {
      // Not saved -> tell the terminal to keep the punches and retry later.
      console.error(`[Device Bridge] Failed to store punches from ${device.serial_number}:`, err instanceof Error ? err.message : err);
      return text('ERROR: RETRY_LATER', 503, { 'Retry-After': '60' });
    }
  }
  return text('OK');
}
