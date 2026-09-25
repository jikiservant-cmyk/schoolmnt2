import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';
import { normalizeDeviceSerialNumber } from '@/lib/devices/serial';

// Device polling for server commands (ADMS /iclock/getrequest)
// Required config to prevent caching the polling endpoint
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sn = searchParams.get('SN');
  
  const cleanSn = normalizeDeviceSerialNumber(sn);
  if (!cleanSn) {
    return new NextResponse('ERROR: INVALID_OR_MISSING_SN', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }

  const supabase = createAdminClient();

  // Validate device exists and is active
  const { data: rawDevice } = await supabase
    .from('devices')
    .select('*')
    .eq('serial_number', cleanSn)
    .maybeSingle();

  if (!rawDevice || !rawDevice.is_active) {
    console.warn(`[ZKTeco ADMS] getrequest from unauthorized or inactive device SN: ${cleanSn}`);
    return new NextResponse('ERROR: UNAUTHORIZED_DEVICE', { 
      status: 401, 
      headers: { 'Content-Type': 'text/plain' } 
    });
  }

  const device = parseDeviceMetadata(rawDevice);
  const adapter = getDeviceAdapter(device.device_type);

  // Enforce token/secret verification
  const isAuth = await adapter.buildAuthCheck(req, device);
  if (!isAuth) {
    console.warn(`[ZKTeco ADMS] getrequest authentication failed for SN: ${cleanSn}`);
    return new NextResponse('ERROR: INVALID_CREDENTIALS', { status: 401 });
  }

  // 1. Update device heartbeat
  await supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device.id);

  // 2. Fetch pending commands from primary school.device_commands queue
  const { data: dbCommands, error: dbCmdsErr } = await supabase
    .from('device_commands')
    .select('id, raw_command')
    .eq('status', 'pending')
    .eq('school_id', device.school_id)
    .in('target_serial', [cleanSn, 'ALL'])
    .order('created_at', { ascending: true })
    .limit(50);

  if (dbCmdsErr) {
    console.warn('[ZKTeco ADMS] Primary school command queue query failed; trying the legacy queue:', dbCmdsErr.message);
  }

  const commandList: { id: string | number; text: string }[] = [];
  const sentCommandIds: string[] = [];

  if (dbCommands && dbCommands.length > 0) {
    dbCommands.forEach((c) => {
      sentCommandIds.push(c.id);
      commandList.push({
        id: c.id,
        text: c.raw_command.trim()
      });
    });

    // Mark commands as sent to device
    const { error: markSentError } = await supabase
      .from('device_commands')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('school_id', device.school_id)
      .in('id', sentCommandIds);
    if (markSentError) {
      console.error('[ZKTeco ADMS] Failed to mark school-scoped commands as sent:', markSentError);
      return new NextResponse('ERROR: COMMAND_QUEUE_UNAVAILABLE', { status: 503 });
    }
  }

  // Fallback: Check legacy device_logs queue if primary queue was empty
  if (commandList.length === 0) {
    const { data: legacyCmds, error: legacyQueryError } = await supabase
      .from('device_logs')
      .select('id, payload')
      .eq('processed', false)
      .eq('device_user_id', 'COMMAND')
      .eq('school_id', device.school_id)
      .in('raw_serial_number', [cleanSn, 'ALL'])
      .order('event_timestamp', { ascending: true })
      .limit(50);

    if (legacyQueryError) {
      console.error('[ZKTeco ADMS] Legacy command queue unavailable:', legacyQueryError);
      return new NextResponse('ERROR: COMMAND_QUEUE_UNAVAILABLE', { status: 503 });
    }

    const processedLogIds: string[] = [];
    if (legacyCmds && legacyCmds.length > 0) {
      legacyCmds.forEach((c, idx) => {
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
      const { error: legacyUpdateError } = await supabase
        .from('device_logs')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('school_id', device.school_id)
        .in('id', processedLogIds);
      if (legacyUpdateError) {
        console.error('[ZKTeco ADMS] Failed to mark legacy school-scoped commands as sent:', legacyUpdateError);
        return new NextResponse('ERROR: COMMAND_QUEUE_UNAVAILABLE', { status: 503 });
      }
    }
  }

  if (commandList.length > 0) {
    // 4. Format ZKTeco ADMS response: C:<id>:<command>
    const responseBody = commandList.map((c) => {
      return `C:${c.id}:${c.text}`;
    }).join('\n');
    
    console.log(`[ZKTeco ADMS] Sending ${commandList.length} queued command(s) to terminal SN ${cleanSn}.`);
    
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

