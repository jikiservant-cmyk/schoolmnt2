import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';
import { processAttendanceEvents } from '@/lib/devices/processor';

async function resolveDevice(req: NextRequest, rawBody?: string) {
  const url = new URL(req.url);
  
  // Extract serial number from query, header, or body
  let sn = 
    url.searchParams.get('sn') ||
    url.searchParams.get('SN') ||
    url.searchParams.get('serial') ||
    url.searchParams.get('device_id') ||
    req.headers.get('x-device-sn') ||
    req.headers.get('x-serial-number');

  if (!sn && rawBody) {
    try {
      const parsed = JSON.parse(rawBody);
      sn = parsed.serialNumber || 
           parsed.serial_number || 
           parsed.sn || 
           parsed.SN || 
           parsed.terminal_id || 
           parsed.deviceId ||
           parsed.AccessControllerEvent?.serialNo;
    } catch {
      // ignore
    }
  }

  if (!sn || !sn.trim()) {
    return { error: 'Missing device serial number (provide via ?sn=..., x-device-sn header, or payload serialNumber)', status: 400 };
  }

  const cleanSn = sn.trim().toUpperCase();
  const supabase = createAdminClient();

  const { data: rawDevice, error } = await supabase
    .from('devices')
    .select('*')
    .ilike('serial_number', cleanSn)
    .maybeSingle();

  if (error || !rawDevice) {
    return { error: `Device with serial number "${cleanSn}" is not registered in the system`, status: 404 };
  }

  if (!rawDevice.is_active) {
    return { error: `Device "${cleanSn}" is currently marked inactive in the school portal`, status: 403 };
  }

  const device = parseDeviceMetadata(rawDevice);
  const adapter = getDeviceAdapter(device.device_type);

  const isAuth = await adapter.buildAuthCheck(req, device);
  if (!isAuth) {
    return { error: 'Invalid or missing authentication token for this device', status: 401 };
  }

  return { device, adapter, supabase };
}

// GET: Probe / Handshake / Healthcheck endpoint
export async function GET(req: NextRequest) {
  const resolved = await resolveDevice(req);
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const { device, adapter, supabase } = resolved;

  // Heartbeat
  supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id)
    .then();

  const handshake = adapter.buildHandshakeResponse(device);
  const body = typeof handshake.body === 'string' ? JSON.parse(handshake.body) : handshake.body;

  return NextResponse.json({
    status: 'online',
    device: {
      serial_number: device.serial_number,
      label: device.label,
      protocol: device.device_type,
      adapter: adapter.displayName,
    },
    handshake: body
  });
}

// POST: Universal push ingestion
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const resolved = await resolveDevice(req, rawBody);

  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const { device, adapter, supabase } = resolved;

  // Update heartbeat asynchronously
  supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id)
    .then();

  // Parse incoming events using the resolved vendor adapter
  const events = await adapter.parseIncomingPush(rawBody, req.headers, new URL(req.url), device);

  let stats = {
    totalReceived: events.length,
    insertedAttendanceLogs: 0,
    queuedSmsCount: 0,
    skippedDuplicates: 0
  };

  if (events.length > 0) {
    const processResult = await processAttendanceEvents(events, device);
    stats = {
      totalReceived: processResult.totalReceived,
      insertedAttendanceLogs: processResult.insertedAttendanceLogs,
      queuedSmsCount: processResult.queuedSmsCount,
      skippedDuplicates: processResult.skippedDuplicates
    };
  }

  return NextResponse.json({
    success: true,
    message: `Processed ${events.length} event(s) using ${adapter.displayName}`,
    stats
  });
}
