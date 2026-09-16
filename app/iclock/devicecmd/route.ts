import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';

// Device responding with the execution status of a command (ZKTeco ADMS /iclock/devicecmd)
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN');
  
  if (!sn || !sn.trim()) {
    return new NextResponse('ERROR: Missing SN', { status: 400 });
  }

  const rawBody = await req.text();
  console.log(`[ZKTeco ADMS] DeviceCmd POST from SN: ${sn}`);

  const supabase = createAdminClient();
  const cleanSn = sn.trim().toUpperCase().replace(/[%_]/g, '');

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

  if (rawBody && rawBody.trim()) {
    try {
      const supabase = createAdminClient();
      const lines = rawBody.split('\n').map(l => l.trim()).filter(Boolean);

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
            await supabase
              .from('device_commands')
              .update(updatePayload)
              .eq('id', cmdId)
              .eq('school_id', device.school_id);
          }
        }
      }
    } catch (err) {
      console.warn('[ZKTeco ADMS] Error updating command acknowledgment:', err);
    }
  }

  // Return OK to acknowledge receiving the command execution result
  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
