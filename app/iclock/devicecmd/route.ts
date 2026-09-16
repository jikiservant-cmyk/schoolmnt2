import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';

// Device responding with the execution status of a command (ZKTeco ADMS /iclock/devicecmd)
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN');
  
  const rawBody = await req.text();
  console.log(`[ZKTeco ADMS] DeviceCmd POST from SN: ${sn}`);
  console.log(`[ZKTeco ADMS] Payload:\n${rawBody}`);

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
              .eq('id', cmdId);
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
