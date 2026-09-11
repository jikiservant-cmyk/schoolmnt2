import { createAdminClient } from '@/utils/supabase/admin';

/**
 * Resolves all active device serial numbers registered to a given school.
 * Enrollment commands must NEVER be broadcast platform-wide — only to the
 * school that actually owns the person being enrolled.
 */
export async function getDeviceSerialsForSchool(schoolId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data: devices, error } = await admin
    .from('devices')
    .select('serial_number')
    .eq('school_id', schoolId)
    .eq('is_active', true);

  if (error || !devices) return [];
  return devices.map(d => d.serial_number.toUpperCase());
}

/**
 * Enqueues a command to be fetched by the ZKTeco ADMS terminal during its next heartbeat
 * deviceSerialNumber is now required to prevent accidental platform-wide broadcasting of enrollments.
 */
export async function enqueueDeviceCommand(
  command: string,
  deviceSerialNumber: string
): Promise<{ success: boolean; commandId: string }> {
  const commandId = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const cleanSn = deviceSerialNumber.trim().toUpperCase();

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

/**
 * Convenience wrapper: push one command to every device a school owns.
 */
export async function enqueueDeviceCommandForSchool(command: string, schoolId: string) {
  const serials = await getDeviceSerialsForSchool(schoolId);
  if (serials.length === 0) {
    console.warn(`[ADMS] No active devices found for school ${schoolId}, command not sent.`);
    return { success: false, commandIds: [] };
  }
  const results = await Promise.all(serials.map(sn => enqueueDeviceCommand(command, sn)));
  return { success: results.every(r => r.success), commandIds: results.map(r => r.commandId) };
}

