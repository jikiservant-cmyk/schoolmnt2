import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';
import { processAttendanceEvents } from '@/lib/devices/processor';
import { normalizeDeviceSerialNumber } from '@/lib/devices/serial';
import { readRequestTextLimited, RequestBodyTooLargeError } from '@/lib/http/read-limited-body';

const MAX_DEVICE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DEVICE_EVENTS = 1_000;

async function updateHeartbeat(
  supabase: ReturnType<typeof createAdminClient>,
  device: ReturnType<typeof parseDeviceMetadata>
) {
  try {
    const { error } = await supabase
      .from('devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', device.id)
      .eq('school_id', device.school_id);
    if (error) console.warn('[Device Push] Could not update device heartbeat:', error);
  } catch (error) {
    console.warn('[Device Push] Heartbeat update failed:', error);
  }
}

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

  const cleanSn = normalizeDeviceSerialNumber(sn);
  if (!cleanSn) {
    return { error: 'Missing or invalid device serial number.', status: 400 };
  }

  const supabase = createAdminClient();

  const { data: rawDevice, error } = await supabase
    .from('devices')
    .select('*')
    .eq('serial_number', cleanSn)
    .maybeSingle();

  if (error || !rawDevice) {
    return { error: 'Device is not registered.', status: 404 };
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
  await updateHeartbeat(supabase, device);

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
  const url = new URL(req.url);
  const serialInHeadersOrUrl = Boolean(
    url.searchParams.get('sn') ||
    url.searchParams.get('SN') ||
    url.searchParams.get('serial') ||
    url.searchParams.get('device_id') ||
    req.headers.get('x-device-sn') ||
    req.headers.get('x-serial-number')
  );

  // Authenticate before reading the payload whenever the device sent its serial
  // in the protocol's normal query/header location. Body-only legacy clients are
  // still supported, but their body is strictly capped before it is parsed.
  let resolved: Awaited<ReturnType<typeof resolveDevice>> | undefined;
  if (serialInHeadersOrUrl) {
    resolved = await resolveDevice(req);
    if ('error' in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
  }

  let rawBody: string;
  try {
    rawBody = await readRequestTextLimited(req, MAX_DEVICE_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: 'Device payload exceeds the 2 MiB limit.' }, { status: 413 });
    }
    console.error('[Device Push] Failed to read request body:', error);
    return NextResponse.json({ error: 'Could not read device payload.' }, { status: 400 });
  }

  if (!resolved) {
    resolved = await resolveDevice(req, rawBody);
  }
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const { device, adapter, supabase } = resolved;

  // Record heartbeat without allowing an auxiliary timestamp failure to drop attendance events.
  await updateHeartbeat(supabase, device);

  // Parse incoming events using the resolved vendor adapter
  const events = await adapter.parseIncomingPush(rawBody, req.headers, new URL(req.url), device);
  if (events.length > MAX_DEVICE_EVENTS) {
    return NextResponse.json({ error: `Device payload contains more than ${MAX_DEVICE_EVENTS} events.` }, { status: 413 });
  }

  let stats = {
    totalReceived: events.length,
    insertedAttendanceLogs: 0,
    queuedSmsCount: 0,
    skippedDuplicates: 0,
    invalidTenantEventCount: 0,
    errors: [] as string[],
  };

  if (events.length > 0) {
    const processResult = await processAttendanceEvents(events, device);
    stats = {
      totalReceived: processResult.totalReceived,
      insertedAttendanceLogs: processResult.insertedAttendanceLogs,
      queuedSmsCount: processResult.queuedSmsCount,
      skippedDuplicates: processResult.skippedDuplicates,
      invalidTenantEventCount: processResult.invalidTenantEventCount,
      errors: processResult.errors,
    };

    if (processResult.errors.length > 0) {
      const status = processResult.invalidTenantEventCount > 0 ? 422 : 503;
      return NextResponse.json({
        success: false,
        message: 'Attendance events were not fully processed. Check the returned status and retry transient failures.',
        stats,
      }, { status });
    }
  }

  return NextResponse.json({
    success: true,
    message: `Processed ${events.length} event(s) using ${adapter.displayName}`,
    stats
  });
}
