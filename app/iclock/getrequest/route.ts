import { NextRequest, NextResponse } from 'next/server';
import { authenticateDeviceRequest, isSafeDeviceCommand } from '@/lib/devices/gateway';

// Device polling for server commands (ADMS /iclock/getrequest). Never cache.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const text = (body: string, status = 200) => new NextResponse(body, { status, headers: { 'Content-Type': 'text/plain' } });

export async function GET(req: NextRequest) {
  const sn = new URL(req.url).searchParams.get('SN');
  if (!sn || !sn.trim()) return text('OK');

  const auth = await authenticateDeviceRequest(req, sn, 'getrequest');
  if (!auth.ok) return auth.response;
  const { device, supabase, serial } = auth;

  await supabase.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id);

  const commandList: { id: string | number; text: string }[] = [];

  // 1. Primary queue
  const { data: dbCommands } = await supabase
    .from('device_commands')
    .select('id, raw_command')
    .eq('status', 'pending')
    .eq('school_id', device.school_id)
    .in('target_serial', [serial, 'ALL'])
    .order('created_at', { ascending: true })
    .limit(50);

  if (dbCommands && dbCommands.length > 0) {
    const sentIds: string[] = [];
    const rejectedIds: string[] = [];
    for (const c of dbCommands) {
      // A CR/LF inside a command would let it smuggle extra "C:<id>:..." lines
      // (e.g. CLEAR ALL DATA) to the terminal. Refuse and mark it failed.
      if (isSafeDeviceCommand(c.raw_command)) {
        sentIds.push(c.id);
        commandList.push({ id: c.id, text: c.raw_command.trim() });
      } else {
        rejectedIds.push(c.id);
      }
    }
    if (sentIds.length) {
      await supabase.from('device_commands').update({ status: 'sent', sent_at: new Date().toISOString() }).in('id', sentIds);
    }
    if (rejectedIds.length) {
      console.warn(`[ZKTeco ADMS] Refused ${rejectedIds.length} unsafe command(s) for ${serial}`);
      await supabase.from('device_commands').update({ status: 'failed', error_message: 'Rejected: command contains line breaks' }).in('id', rejectedIds);
    }
  }

  // 2. Legacy device_logs queue (only when the primary queue is empty)
  if (commandList.length === 0) {
    const { data: legacyCmds } = await supabase
      .from('device_logs')
      .select('id, payload')
      .eq('processed', false)
      .eq('device_user_id', 'COMMAND')
      .eq('school_id', device.school_id)
      .in('raw_serial_number', [serial, 'ALL'])
      .order('event_timestamp', { ascending: true })
      .limit(50);

    if (legacyCmds && legacyCmds.length > 0) {
      legacyCmds.forEach((c, idx) => {
        const rawCmd = (c.payload as { cmd?: string } | null)?.cmd;
        if (isSafeDeviceCommand(rawCmd)) commandList.push({ id: idx + 1, text: rawCmd.trim() });
      });
      await supabase
        .from('device_logs')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .in('id', legacyCmds.map((c) => c.id));
    }
  }

  if (commandList.length === 0) return text('OK');

  // Log only the count: commands carry names/PINs (personal data).
  console.log(`[ZKTeco ADMS] Sending ${commandList.length} command(s) to ${serial}`);
  return text(commandList.map((c) => `C:${c.id}:${c.text}`).join('\n'));
}
