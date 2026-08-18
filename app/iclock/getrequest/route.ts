import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { getPendingCommandsForDevice, markCommandProcessed } from '@/utils/zkteco/commandQueue';

// Device polling for server commands (ADMS /iclock/getrequest)
// Required config to prevent caching the polling endpoint
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN');
  
  if (!sn || !sn.trim()) {
    return new NextResponse('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  const cleanSn = sn.trim().toUpperCase();
  const supabase = createAdminClient();

  // Validate device exists and is active
  const { data: device } = await supabase
    .from('devices')
    .select('id, school_id, is_active')
    .ilike('serial_number', cleanSn)
    .maybeSingle();

  if (!device || !device.is_active) {
    console.warn(`[ZKTeco ADMS] getrequest from unauthorized or inactive device SN: ${cleanSn}`);
    return new NextResponse('ERROR: UNAUTHORIZED_DEVICE', { 
      status: 401, 
      headers: { 'Content-Type': 'text/plain' } 
    });
  }

  // 1. Update device heartbeat
  await supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id);

  // 2. Fetch pending commands from database queue strictly for this device
  const { data: cmds } = await supabase
    .from('device_logs')
    .select('id, payload')
    .eq('processed', false)
    .eq('device_user_id', 'COMMAND')
    .in('raw_serial_number', [cleanSn, 'ALL'])
    .order('event_timestamp', { ascending: true })
    .limit(100);

  // 3. Also check in-memory queue for this device
  const memCmds = getPendingCommandsForDevice(cleanSn);

  const commandList: { id: string | number; text: string }[] = [];
  const processedLogIds: string[] = [];

  if (cmds && cmds.length > 0) {
    cmds.forEach((c, idx) => {
      processedLogIds.push(c.id);
      const payloadObj = c.payload as { cmd?: string };
      const rawCmd = payloadObj?.cmd?.trim();
      if (rawCmd) {
        commandList.push({
          id: idx + 1,
          text: rawCmd
        });
      }
    });
  }

  // Add memory queue commands (prevent duplicates)
  for (const mc of memCmds) {
    markCommandProcessed(mc.id);
    const rawCmd = mc.command.trim();
    if (rawCmd && !commandList.some(c => c.text === rawCmd)) {
      commandList.push({
        id: commandList.length + 1,
        text: rawCmd
      });
    }
  }

  if (processedLogIds.length > 0) {
    // Mark database commands as processed so they aren't delivered repeatedly
    await supabase
      .from('device_logs')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .in('id', processedLogIds);
  }

  if (commandList.length > 0) {
    // 4. Format ZKTeco ADMS response: C:<id>:<command>
    const responseBody = commandList.map((c) => {
      return `C:${c.id}:${c.text}`;
    }).join('\n');
    
    console.log(`[ZKTeco ADMS] Sending ${commandList.length} commands to terminal SN ${cleanSn}:\n${responseBody}`);
    
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

