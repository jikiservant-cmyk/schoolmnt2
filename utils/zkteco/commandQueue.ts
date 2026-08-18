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

  try {
    const admin = createAdminClient();
    
    // Attempt to persist to device_commands table if it exists
    await admin
      .from('device_commands')
      .insert({
        id: commandId,
        command_text: command,
        device_serial: deviceSerialNumber || null,
        status: 'pending',
        created_at: new Date().toISOString(),
      })
      .then(() => {}, (dbErr: any) => {
        // Table might not exist yet; gracefully fallback to in-memory queue
        console.warn('Persisting command to DB fallback to memory queue:', dbErr?.message || dbErr);
      });
  } catch (e) {
    // Non-fatal
  }

  // Push to memory queue for instant dispatch
  globalCommandQueue.push({
    id: commandId,
    command,
    deviceSerialNumber,
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
  return globalCommandQueue.filter(
    (c) => !c.deviceSerialNumber || c.deviceSerialNumber === deviceSerialNumber
  );
}

/**
 * Clears processed commands
 */
export function markCommandProcessed(commandId: string): void {
  const index = globalCommandQueue.findIndex((c) => c.id === commandId);
  if (index !== -1) {
    globalCommandQueue.splice(index, 1);
  }
}
