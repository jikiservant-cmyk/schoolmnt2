import { NextRequest, NextResponse } from 'next/server';
import { authenticateDeviceRequest, readDeviceBody, payloadTooLarge } from '@/lib/devices/gateway';
import { isUuid } from '@/lib/tenant';
import { deviceCommandId, isDeviceCommandId } from '@/lib/devices/commandId';

export const dynamic = 'force-dynamic';

const text = (body: string, status = 200) => new NextResponse(body, { status, headers: { 'Content-Type': 'text/plain' } });

// Device reports the execution result of queued commands (ADMS /iclock/devicecmd).
export async function POST(req: NextRequest) {
  const sn = new URL(req.url).searchParams.get('SN');
  if (!sn || !sn.trim()) return text('ERROR: Missing SN', 400);

  // Authenticate BEFORE reading the body (it used to be read first, unbounded).
  const auth = await authenticateDeviceRequest(req, sn, 'devicecmd');
  if (!auth.ok) return auth.response;
  const { device, supabase, serial } = auth;

  const rawBody = await readDeviceBody(req, 256 * 1024);
  if (rawBody === null) return payloadTooLarge();

  const lines = rawBody.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 500);

  // Terminals echo the short id from getrequest (deviceCommandId). Map it back
  // to the queue row among this device's commands that are awaiting a reply.
  // (Full UUIDs are still accepted for commands sent before this change.)
  let shortIdMap: Map<string, string> | null = null;
  const resolveId = async (echoed: string | null): Promise<string | null> => {
    if (!echoed) return null;
    if (isUuid(echoed)) return echoed;
    if (!isDeviceCommandId(echoed)) return null;
    if (!shortIdMap) {
      shortIdMap = new Map();
      const { data: awaiting } = await supabase
        .from('device_commands')
        .select('id')
        .eq('school_id', device.school_id)
        .in('target_serial', [serial, 'ALL'])
        .eq('status', 'sent')
        .order('sent_at', { ascending: false })
        .limit(1000);
      for (const row of awaiting || []) shortIdMap.set(deviceCommandId(String(row.id)), String(row.id));
    }
    return shortIdMap.get(echoed) ?? null;
  };

  for (const line of lines) {
    const params = new URLSearchParams(line);
    const cmdId = await resolveId(params.get('ID'));
    if (!cmdId) continue;
    const returnCode = (params.get('Return') || '').slice(0, 16);
    const ok = returnCode === '0';
    const update: Record<string, unknown> = {
      status: ok ? 'acknowledged' : 'failed',
      acknowledged_at: new Date().toISOString(),
    };
    if (!ok) update.error_message = `Terminal execution return code: ${returnCode}`;

    const { error } = await supabase
      .from('device_commands')
      .update(update)
      .eq('id', cmdId)
      .eq('school_id', device.school_id)
      .in('target_serial', [serial, 'ALL']);
    if (error) console.warn(`[ZKTeco ADMS] ack update failed for ${serial}:`, error.message);
  }

  return text('OK');
}
