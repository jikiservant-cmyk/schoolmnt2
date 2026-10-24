import { NextRequest, NextResponse } from 'next/server';
import { authenticateDeviceRequest, isSafeDeviceCommand } from '@/lib/devices/gateway';
import { deviceCommandId } from '@/lib/devices/commandId';
import { extractMissingColumn } from '@/lib/tenant';

// Device polling for server commands (ADMS /iclock/getrequest). Never cache.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const text = (body: string, status = 200) => new NextResponse(body, { status, headers: { 'Content-Type': 'text/plain' } });

async function updateDeviceCommandsSafe(
  supabase: any,
  schoolId: string,
  ids: string[],
  fields: Record<string, unknown>
) {
  if (ids.length === 0) return;
  const payload = { ...fields };
  for (let attempt = 0; attempt < 5; attempt++) {
    const { error } = await supabase
      .from('device_commands')
      .update(payload)
      .eq('school_id', schoolId)
      .in('id', ids);
    if (!error) return;
    const missing = extractMissingColumn(error);
    if (missing && Object.prototype.hasOwnProperty.call(payload, missing)) {
      delete payload[missing];
      if (Object.keys(payload).length === 0) return;
      continue;
    }
    return;
  }
}

export async function GET(req: NextRequest) {
  const sn = new URL(req.url).searchParams.get('SN');
  if (!sn || !sn.trim()) return text('OK');

  const auth = await authenticateDeviceRequest(req, sn, 'getrequest');
  if (!auth.ok) return auth.response;
  const { device, supabase, serial } = auth;

  await supabase.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id);

  const commandList: { id: string | number; text: string }[] = [];

  // 1. Primary queue (with per-device delivery tracking on `target_serial = 'ALL'` broadcasts)
  let hasDeliveredColumn = true;
  let dbCommands: Array<{
    id: string;
    target_serial: string;
    raw_command: string;
    delivered_device_ids?: string[] | null;
  }> | null = null;

  const fullQuery = await supabase
    .from('device_commands')
    .select('id, target_serial, raw_command, delivered_device_ids')
    .eq('status', 'pending')
    .eq('school_id', device.school_id)
    .in('target_serial', [serial, 'ALL'])
    .order('created_at', { ascending: true })
    .limit(200);

  if (fullQuery.error && extractMissingColumn(fullQuery.error) === 'delivered_device_ids') {
    hasDeliveredColumn = false;
    const legacyQuery = await supabase
      .from('device_commands')
      .select('id, target_serial, raw_command')
      .eq('status', 'pending')
      .eq('school_id', device.school_id)
      .in('target_serial', [serial, 'ALL'])
      .order('created_at', { ascending: true })
      .limit(50);
    dbCommands = legacyQuery.data;
  } else {
    dbCommands = fullQuery.data;
  }

  if (dbCommands && dbCommands.length > 0) {
    const hasBroadcast = dbCommands.some((c) => c.target_serial === 'ALL');
    let activeSchoolGateIds: string[] = [String(device.id)];
    if (hasBroadcast && hasDeliveredColumn) {
      const { data: activeDevs } = await supabase
        .from('devices')
        .select('id')
        .eq('school_id', device.school_id)
        .eq('is_active', true);
      if (activeDevs && activeDevs.length > 0) {
        activeSchoolGateIds = Array.from(
          new Set([...activeDevs.map((d: any) => String(d.id)), String(device.id)])
        );
      }
    }

    const currentDeviceId = String(device.id);
    const nowIso = new Date().toISOString();
    const directSentIds: string[] = [];
    const rejectedIds: string[] = [];

    for (const c of dbCommands) {
      if (commandList.length >= 50) break;

      // A CR/LF inside a command would let it smuggle extra "C:<id>:..." lines
      // (e.g. CLEAR ALL DATA) to the terminal. Refuse and mark it failed.
      if (!isSafeDeviceCommand(c.raw_command)) {
        rejectedIds.push(c.id);
        continue;
      }

      if (c.target_serial === 'ALL' && hasDeliveredColumn) {
        const prevDelivered = Array.isArray(c.delivered_device_ids)
          ? c.delivered_device_ids.map(String)
          : [];
        if (prevDelivered.includes(currentDeviceId)) {
          continue;
        }

        commandList.push({ id: c.id, text: c.raw_command.trim() });

        const nextDelivered = Array.from(new Set([...prevDelivered, currentDeviceId]));
        const allGatesDelivered = activeSchoolGateIds.every((id) => nextDelivered.includes(id));

        if (allGatesDelivered) {
          await updateDeviceCommandsSafe(supabase, device.school_id, [c.id], {
            delivered_device_ids: nextDelivered,
            status: 'sent',
            sent_at: nowIso,
          });
        } else {
          await updateDeviceCommandsSafe(supabase, device.school_id, [c.id], {
            delivered_device_ids: nextDelivered,
          });
        }
      } else {
        directSentIds.push(c.id);
        commandList.push({ id: c.id, text: c.raw_command.trim() });
      }
    }

    if (directSentIds.length) {
      await updateDeviceCommandsSafe(supabase, device.school_id, directSentIds, {
        status: 'sent',
        sent_at: nowIso,
      });
    }
    if (rejectedIds.length) {
      console.warn(`[ZKTeco ADMS] Refused ${rejectedIds.length} unsafe command(s) for ${serial}`);
      await updateDeviceCommandsSafe(supabase, device.school_id, rejectedIds, {
        status: 'failed',
        error_message: 'Rejected: command contains line breaks',
      });
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
  // CmdID must be 1-16 letters/digits (ZKTeco PUSH spec); UUIDs were refused.
  return text(commandList.map((c) => `C:${deviceCommandId(c.id)}:${c.text}`).join('\n'));
}
