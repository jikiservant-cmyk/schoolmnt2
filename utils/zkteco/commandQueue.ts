import { createAdminClient } from '@/utils/supabase/admin';

/**
 * Enqueues a command to be fetched by the ZKTeco ADMS terminal during its next heartbeat
 */
export async function enqueueDeviceCommand(
  command: string,
  deviceSerialNumber?: string
): Promise<{ success: boolean; commandId: string }> {
  const commandId = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const cleanSn = deviceSerialNumber && deviceSerialNumber.trim() 
    ? deviceSerialNumber.trim().toUpperCase() 
    : 'ALL';

  try {
    const admin = createAdminClient();
    
    // Resolve device_id if cleanSn is specified
    let deviceId: string | null = null;
    if (cleanSn !== 'ALL') {
      const { data: dev } = await admin
        .from('devices')
        .select('id')
        .ilike('serial_number', cleanSn)
        .maybeSingle();
      if (dev?.id) deviceId = dev.id;
    }

    // Persist directly into device_logs so getrequest API route reliably picks it up across server instances
    const { error: insertErr } = await admin
      .from('device_logs')
      .insert({
        device_id: deviceId,
        raw_serial_number: cleanSn,
        device_user_id: 'COMMAND',
        event_timestamp: new Date().toISOString(),
        payload: { cmd: command, commandId },
        processed: false,
      });

    if (insertErr) {
      console.warn('[ZKTeco ADMS] Persisting command to device_logs warning:', insertErr.message);
      return { success: false, commandId };
    }
  } catch (e: any) {
    console.warn('[ZKTeco ADMS] Could not persist command to DB:', e?.message || e);
    return { success: false, commandId };
  }

  return { success: true, commandId };
}

