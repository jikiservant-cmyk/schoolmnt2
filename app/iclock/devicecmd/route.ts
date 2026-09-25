import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';
import { normalizeDeviceSerialNumber } from '@/lib/devices/serial';
import { readRequestTextLimited, RequestBodyTooLargeError } from '@/lib/http/read-limited-body';

const MAX_ACK_BODY_BYTES = 128 * 1024;
const MAX_ACK_LINES = 1_000;

// Device responding with the execution status of a command (ZKTeco ADMS /iclock/devicecmd)
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN');
  
  const cleanSn = normalizeDeviceSerialNumber(sn);
  if (!cleanSn) {
    return new NextResponse('ERROR: Missing or invalid SN', { status: 400 });
  }

  const supabase = createAdminClient();

  // Validate device exists and is active
  const { data: rawDevice } = await supabase
    .from('devices')
    .select('*')
    .eq('serial_number', cleanSn)
    .maybeSingle();

  if (!rawDevice || !rawDevice.is_active) {
    console.warn(`[ZKTeco ADMS] devicecmd from unauthorized or inactive device SN: ${cleanSn}`);
    return new NextResponse('ERROR: UNAUTHORIZED_DEVICE', { status: 401 });
  }

  const device = parseDeviceMetadata(rawDevice);
  const adapter = getDeviceAdapter(device.device_type);

  // Enforce token/secret verification
  const isAuth = await adapter.buildAuthCheck(req, device);
  if (!isAuth) {
    console.warn(`[ZKTeco ADMS] devicecmd authentication failed for SN: ${cleanSn}`);
    return new NextResponse('ERROR: INVALID_CREDENTIALS', { status: 401 });
  }

  let rawBody: string;
  try {
    rawBody = await readRequestTextLimited(req, MAX_ACK_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new NextResponse('ERROR: ACK_PAYLOAD_TOO_LARGE', { status: 413 });
    }
    console.error('[ZKTeco ADMS] Could not read command acknowledgment:', error);
    return new NextResponse('ERROR: INVALID_PAYLOAD', { status: 400 });
  }
  console.log(`[ZKTeco ADMS] DeviceCmd POST from SN: ${cleanSn}`);

  if (rawBody && rawBody.trim()) {
    try {
      const lines = rawBody.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length > MAX_ACK_LINES) {
        return new NextResponse('ERROR: TOO_MANY_ACKNOWLEDGEMENTS', { status: 413 });
      }

      for (const line of lines) {
        // Line format: ID=<cmdId>&Return=<0|other>&CMD=...
        const params = new URLSearchParams(line);
        const cmdId = params.get('ID');
        const returnCode = params.get('Return');

        if (cmdId) {
          const isSuccess = returnCode === '0';
          const updatePayload: Record<string, any> = {
            status: isSuccess ? 'acknowledged' : 'failed',
            acknowledged_at: new Date().toISOString()
          };
          if (!isSuccess) {
            updatePayload.error_message = `Terminal execution return code: ${returnCode}`;
          }

          // If cmdId is a UUID, update primary school.device_commands table
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cmdId);
          if (isUuid) {
            const { data: acknowledgedCommand, error: acknowledgementError } = await supabase
              .from('device_commands')
              .update(updatePayload)
              .eq('id', cmdId)
              .eq('school_id', device.school_id)
              .in('target_serial', [cleanSn, 'ALL'])
              .select('id')
              .maybeSingle();
            if (acknowledgementError) {
              console.error('[ZKTeco ADMS] Command acknowledgement update failed:', acknowledgementError);
              return new NextResponse('ERROR: COMMAND_ACK_UNAVAILABLE', { status: 503 });
            }
            if (!acknowledgedCommand) {
              return new NextResponse('ERROR: COMMAND_NOT_FOUND', { status: 404 });
            }
          }
        }
      }
    } catch (err) {
      console.error('[ZKTeco ADMS] Error updating command acknowledgment:', err);
      return new NextResponse('ERROR: COMMAND_ACK_UNAVAILABLE', { status: 503 });
    }
  }

  // Return OK to acknowledge receiving the command execution result
  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
