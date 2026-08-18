import { createAdminClient } from '@/utils/supabase/admin';

interface QueuedCommand {
  id: string;
  command: string;
  deviceSerialNumber?: string;
  createdAt: number;
}

// In-memory fallback queue for active ADMS polling
const globalCommandQueue: QueuedCommand[] = [];

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
    }
  } catch (e: any) {
    console.warn('[ZKTeco ADMS] Could not persist command to DB:', e?.message || e);
  }

  // Push to memory queue for instant dispatch in same node process
  globalCommandQueue.push({
    id: commandId,
    command,
    deviceSerialNumber: cleanSn,
    createdAt: Date.now(),
  });

  return { success: true, commandId };
}

/**
 * Retrieves pending commands for a specific device serial number
 */
export function getPendingCommandsForDevice(deviceSerialNumber?: string): QueuedCommand[] {
  if (!deviceSerialNumber) {
    return [...globalCommandQueue];
  }
  const cleanSn = deviceSerialNumber.trim().toUpperCase();
  return globalCommandQueue.filter(
    (c) => !c.deviceSerialNumber || c.deviceSerialNumber === cleanSn || c.deviceSerialNumber === 'ALL'
  );
}

/**
 * Clears processed commands from in-memory queue
 */
export function markCommandProcessed(commandId: string): void {
  const index = globalCommandQueue.findIndex((c) => c.id === commandId);
  if (index !== -1) {
    globalCommandQueue.splice(index, 1);
  }
}

