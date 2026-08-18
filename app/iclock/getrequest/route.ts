import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';

// Device polling for server commands (ADMS /iclock/getrequest)
// Required config to prevent Vercel from caching the polling endpoint
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN');
  
  if (!sn) {
    return new NextResponse('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  const supabase = createAdminClient();

  // 1. Update device heartbeat
  await supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('serial_number', sn);

  // 2. Fetch pending commands from database queue
  const { data: cmds, error } = await supabase
    .from('device_logs')
    .select('id, payload')
    .eq('processed', false)
    .eq('device_user_id', 'COMMAND')
    .in('raw_serial_number', [sn, 'ALL'])
    .order('event_timestamp', { ascending: true })
    .limit(10);

  if (cmds && cmds.length > 0) {
    // 3. Mark these commands as processed so they aren't sent again
    const ids = cmds.map(c => c.id);
    await supabase
      .from('device_logs')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .in('id', ids);

    // 4. Format ZKTeco ADMS response: C:<id>:<command>
    const responseBody = cmds.map((c, idx) => {
      const payloadObj = c.payload as { cmd?: string };
      const rawCmd = payloadObj?.cmd || '';
      // Create a short numeric ID for the command receipt
      const cmdId = Math.floor(Math.random() * 10000) + idx;
      return `C:${cmdId}:${rawCmd}`;
    }).join('\n');
    
    console.log(`[ZKTeco ADMS] Sending ${cmds.length} commands to SN ${sn}:\n${responseBody}`);
    
    return new NextResponse(responseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
