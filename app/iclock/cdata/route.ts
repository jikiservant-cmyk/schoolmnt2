import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';
import { processAttendanceEvents } from '@/lib/devices/processor';
import { normalizeDeviceSerialNumber } from '@/lib/devices/serial';
import { DeviceRecord, DeviceAdapter } from '@/lib/devices/types';
import { readRequestTextLimited, RequestBodyTooLargeError } from '@/lib/http/read-limited-body';

const MAX_DEVICE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DEVICE_EVENTS = 1_000;

async function updateDeviceHeartbeat(
  supabase: ReturnType<typeof createAdminClient>,
  device: ReturnType<typeof parseDeviceMetadata>
) {
  try {
    const { error } = await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', device.id)
      .eq('school_id', device.school_id);
    if (error) console.warn('[Device Bridge] Could not update device heartbeat:', error);
  } catch (error) {
    console.warn('[Device Bridge] Heartbeat update failed:', error);
  }
}

// Multi-Vendor Biometric Device Authenticator
async function authenticateDevice(req: NextRequest, sn: string | null) {
  const cleanSn = normalizeDeviceSerialNumber(sn);
  if (!cleanSn) {
    return { authenticated: false, reason: 'Missing or invalid device serial number (SN)' };
  }

  const supabase = createAdminClient();

  const { data: rawDevice, error } = await supabase
    .from('devices')
    .select('*')
    .eq('serial_number', cleanSn)
    .maybeSingle();

  if (error || !rawDevice) {
    return { authenticated: false, reason: 'Unregistered device' };
  }

  if (!rawDevice.is_active) {
    return { authenticated: false, reason: `Device ${cleanSn} is deactivated in portal` };
  }

  const device = parseDeviceMetadata(rawDevice);
  const adapter = getDeviceAdapter(device.device_type);

  const isAuth = await adapter.buildAuthCheck(req, device);
  if (!isAuth) {
    return { authenticated: false, reason: 'Invalid or missing device authentication token' };
  }

  return { authenticated: true, device, adapter, supabase };
}

// 1. Initial Handshake / Config Negotiation (ADMS GET)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN') || searchParams.get('sn') || req.headers.get('x-device-sn');

  console.log(`[Device Bridge /iclock/cdata] Init GET handshake from SN: ${sn}`);

  const authResult = await authenticateDevice(req, sn);
  if (!authResult.authenticated || !authResult.device || !authResult.adapter) {
    console.warn(`[Device Bridge] Rejected GET from device: ${sn}. Reason: ${authResult.reason}`);
    return new NextResponse(`ERROR: ${authResult.reason}`, {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const { device, adapter, supabase } = authResult;

  // Update heartbeat without returning credentials or crossing school scope.
  await updateDeviceHeartbeat(supabase, device);

  const handshake = adapter.buildHandshakeResponse(device);
  const responseContent = typeof handshake.body === 'string' 
    ? handshake.body 
    : JSON.stringify(handshake.body);

  return new NextResponse(responseContent, {
    status: handshake.status || 200,
    headers: {
      'Content-Type': handshake.contentType,
      ...(handshake.headers || {})
    }
  });
}

// 2. Data Push (Attendance logs, Realtime punches)
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN') || searchParams.get('sn') || req.headers.get('x-device-sn') || '';
  const table = (searchParams.get('table') || searchParams.get('TABLE') || '').toUpperCase();

  const authResult = await authenticateDevice(req, sn);
  if (!authResult.authenticated || !authResult.device || !authResult.adapter) {
    console.warn(`[Device Bridge] Rejected POST from device: ${sn}. Reason: ${authResult.reason}`);
    return new NextResponse(`ERROR: ${authResult.reason}`, {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const { device, adapter, supabase } = authResult;
  let rawBody: string;
  try {
    rawBody = await readRequestTextLimited(req, MAX_DEVICE_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new NextResponse('ERROR: PAYLOAD_TOO_LARGE', { status: 413, headers: { 'Content-Type': 'text/plain' } });
    }
    console.error('[Device Bridge] Failed to read device payload:', error);
    return new NextResponse('ERROR: INVALID_PAYLOAD', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }
  console.log(`[Device Bridge] POST from SN: ${sn} (${adapter.displayName}), Table: ${table || 'DEFAULT'}, Body Length: ${rawBody.length}`);

  // Record the authenticated device heartbeat; any failure is logged without dropping events.
  await updateDeviceHeartbeat(supabase, device);

  // Parse incoming push using device's vendor adapter
  const events = await adapter.parseIncomingPush(rawBody, req.headers, new URL(req.url), device);
  if (events.length > MAX_DEVICE_EVENTS) {
    return new NextResponse(`ERROR: TOO_MANY_EVENTS (${MAX_DEVICE_EVENTS} max)`, {
      status: 413,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (events && events.length > 0) {
    console.log(`[Device Bridge] Adapter ${adapter.displayName} produced ${events.length} normalized attendance events`);
    const result = await processAttendanceEvents(events, device);
    if (result.errors.length > 0) {
      const status = result.invalidTenantEventCount > 0 ? 422 : 503;
      return new NextResponse('ERROR: ATTENDANCE_PROCESSING_FAILED', {
        status,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  }

  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
