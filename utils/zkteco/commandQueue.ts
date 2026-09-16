import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';
import { EnrollPersonInput } from '@/lib/devices/types';

/**
 * Resolves all active device records registered to a given school.
 * Enrollment commands must NEVER be broadcast platform-wide — only to the
 * school that actually owns the person being enrolled.
 */
export async function getActiveDevicesForSchool(schoolId: string) {
  const admin = createAdminClient();
  const { data: devices, error } = await admin
    .from('devices')
    .select('*')
    .eq('school_id', schoolId)
    .eq('is_active', true);

  if (error || !devices) return [];
  return devices.map(d => parseDeviceMetadata(d));
}

/**
 * Resolves all active device serial numbers registered to a given school.
 */
export async function getDeviceSerialsForSchool(schoolId: string): Promise<string[]> {
  const devices = await getActiveDevicesForSchool(schoolId);
  return devices.map(d => d.serial_number.toUpperCase());
}

export interface EnqueueCommandOptions {
  schoolId?: string;
  commandType?: 'ENROLL_USER' | 'DELETE_USER' | 'SYNC_TIME' | 'REBOOT' | string;
  payload?: Record<string, any>;
  vendorProtocol?: string;
}

/**
 * Enqueues a command for a specific device serial number into school.device_commands.
 */
export async function enqueueDeviceCommand(
  command: string,
  deviceSerialNumber: string,
  options?: EnqueueCommandOptions
): Promise<{ success: boolean; commandId: string }> {
  let commandId = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const cleanSn = deviceSerialNumber.trim().toUpperCase();

  try {
    const admin = createAdminClient();
    
    // Resolve device info if cleanSn is specified
    let deviceId: string | null = null;
    let schoolId: string | null = options?.schoolId || null;
    let vendorProtocol: string = options?.vendorProtocol || 'zkteco_adms';

    if (cleanSn !== 'ALL') {
      const { data: dev } = await admin
        .from('devices')
        .select('id, school_id, device_type')
        .ilike('serial_number', cleanSn)
        .maybeSingle();

      if (dev) {
        deviceId = dev.id;
        if (!schoolId) schoolId = dev.school_id;
        if (dev.device_type) vendorProtocol = dev.device_type;
      }
    }

    // 1. Primary: Insert into school.device_commands if school_id is known
    if (schoolId) {
      const { data: cmdRow, error: cmdErr } = await admin
        .from('device_commands')
        .insert({
          school_id: schoolId,
          device_id: deviceId,
          target_serial: cleanSn,
          vendor_protocol: vendorProtocol,
          command_type: options?.commandType || 'ENROLL_USER',
          payload: options?.payload || { raw_command: command, commandId },
          raw_command: command,
          status: 'pending'
        })
        .select('id')
        .maybeSingle();

      if (!cmdErr && cmdRow?.id) {
        return { success: true, commandId: cmdRow.id };
      }
      if (cmdErr) {
        console.warn('[Device Command Queue] device_commands insert failed, trying device_logs fallback:', cmdErr.message);
      }
    }

    // 2. Fallback: Persist into device_logs so getrequest API route still works
    const { error: insertErr } = await admin
      .from('device_logs')
      .insert({
        device_id: deviceId,
        raw_serial_number: cleanSn,
        device_user_id: 'COMMAND',
        event_timestamp: new Date().toISOString(),
        payload: { cmd: command, commandId, ...(options?.payload || {}) },
        processed: false,
      });

    if (insertErr) {
      console.warn('[Device Command Queue] Persisting command to device_logs warning:', insertErr.message);
      return { success: false, commandId };
    }
  } catch (e: any) {
    console.warn('[Device Command Queue] Could not persist command to DB:', e?.message || e);
    return { success: false, commandId };
  }

  return { success: true, commandId };
}

/**
 * Convenience wrapper: push one raw command to every device a school owns.
 */
export async function enqueueDeviceCommandForSchool(command: string, schoolId: string) {
  const serials = await getDeviceSerialsForSchool(schoolId);
  if (serials.length === 0) {
    console.warn(`[Device Command Queue] No active devices found for school ${schoolId}, command not sent.`);
    return { success: false, commandIds: [] };
  }
  const results = await Promise.all(serials.map(sn => enqueueDeviceCommand(command, sn, { schoolId })));
  return { success: results.every(r => r.success), commandIds: results.map(r => r.commandId) };
}

/**
 * Multi-Vendor Outbound Enrollment:
 * Enqueues a member's enrollment command dynamically translated to each device's vendor protocol.
 */
export async function enqueuePersonEnrollmentForSchool(
  person: EnrollPersonInput,
  schoolId: string
) {
  const devices = await getActiveDevicesForSchool(schoolId);
  if (devices.length === 0) {
    return { success: false, queuedCount: 0, message: 'No active devices registered.' };
  }

  let successCount = 0;
  for (const dev of devices) {
    const adapter = getDeviceAdapter(dev.device_type);
    const enrollResult = adapter.buildEnrollCommand(person, dev);

    if (enrollResult.transportType === 'adms_command' || enrollResult.transportType === 'rest_api') {
      const res = await enqueueDeviceCommand(
        enrollResult.command, 
        dev.serial_number,
        {
          schoolId,
          commandType: 'ENROLL_USER',
          payload: {
            pin: person.pin,
            fullName: person.fullName,
            role: person.role,
            className: person.className || null
          },
          vendorProtocol: dev.device_type
        }
      );
      if (res.success) successCount++;
    }
  }

  return {
    success: successCount > 0,
    queuedCount: successCount,
    totalDevices: devices.length
  };
}
