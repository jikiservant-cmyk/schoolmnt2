import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';
import { processAttendanceEvents } from '@/lib/devices/processor';
import { DeviceRecord, DeviceAdapter } from '@/lib/devices/types';

// Multi-Vendor Biometric Device Authenticator
async function authenticateDevice(req: NextRequest, sn: string | null) {
  if (!sn || !sn.trim()) {
    return { authenticated: false, reason: 'Missing device serial number (SN)' };
  }

  const cleanSn = sn.trim().toUpperCase();
  const supabase = createAdminClient();

  const { data: rawDevice, error } = await supabase
    .from('devices')
    .select('*')
    .ilike('serial_number', cleanSn)
    .maybeSingle();

  if (error || !rawDevice) {
    return { authenticated: false, reason: `Unregistered device serial number: ${cleanSn}` };
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

  // Update device heartbeat
  await supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id);

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
  const rawBody = await req.text();
  console.log(`[Device Bridge] POST from SN: ${sn} (${adapter.displayName}), Table: ${table || 'DEFAULT'}, Body Length: ${rawBody.length}`);

  // Fire-and-forget heartbeat update
  supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id)
    .then();

  // Parse incoming push using device's vendor adapter
  const events = await adapter.parseIncomingPush(rawBody, req.headers, new URL(req.url), device);

  if (events && events.length > 0) {
    console.log(`[Device Bridge] Adapter ${adapter.displayName} produced ${events.length} normalized attendance events`);
    await processAttendanceEvents(events, device);
  }

  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
