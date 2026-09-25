import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';
import { normalizeDeviceSerialNumber } from '@/lib/devices/serial';
import { isDeviceOwnedBySchool } from '@/lib/devices/tenant-safety';
import { EnrollPersonInput, DeviceRecord } from '@/lib/devices/types';

/**
 * Resolves all active device records registered to a given school.
 * Enrollment commands must NEVER be broadcast platform-wide — only to the
 * school that actually owns the person being enrolled.
 */
export async function getActiveDevicesForSchool(schoolId: string) {
  if (!schoolId) return [];

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
 * Enqueues a command for a single registered device, or a school-scoped ALL
 * broadcast. A supplied school ID is checked against the device owner before
 * either queue is written.
 */
export async function enqueueDeviceCommand(
  command: string,
  deviceSerialNumber: string,
  options?: EnqueueCommandOptions
): Promise<{ success: boolean; commandId: string }> {
  let commandId = `cmd_${randomUUID()}`;
  const rawSerial = typeof deviceSerialNumber === 'string' ? deviceSerialNumber.trim() : '';
  const cleanSn = rawSerial.toUpperCase();
  const isBroadcast = cleanSn === 'ALL';

  try {
    const admin = createAdminClient();
    let deviceId: string | null = null;
    let schoolId: string | null = options?.schoolId || null;
    let vendorProtocol: string = options?.vendorProtocol || 'zkteco_adms';

    if (isBroadcast) {
      if (!schoolId) {
        console.warn('[Device Command Queue] Refusing unscoped ALL-device broadcast.');
        return { success: false, commandId };
      }
    } else {
      const normalizedSerial = normalizeDeviceSerialNumber(rawSerial);
      if (!normalizedSerial) {
        console.warn('[Device Command Queue] Refusing command with invalid device serial.');
        return { success: false, commandId };
      }

      const { data: dev, error: deviceError } = await admin
        .from('devices')
        .select('id, school_id, device_type, is_active')
        .eq('serial_number', normalizedSerial)
        .eq('is_active', true)
        .maybeSingle();

      if (deviceError || !dev) {
        console.warn('[Device Command Queue] Refusing command for an unknown device serial.');
        return { success: false, commandId };
      }

      if (schoolId && !isDeviceOwnedBySchool(dev, schoolId)) {
        console.warn('[Device Command Queue] Refusing cross-school device command.');
        return { success: false, commandId };
      }

      deviceId = dev.id;
      schoolId = dev.school_id;
      if (dev.device_type) vendorProtocol = dev.device_type;
    }

    // No write is allowed without an authenticated school/device context.
    if (!schoolId) return { success: false, commandId };

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

    // Legacy fallback must carry the tenant ID too; /iclock/getrequest filters
    // this queue by school_id before returning a command to any terminal.
    const { error: insertErr } = await admin
      .from('device_logs')
      .insert({
        school_id: schoolId,
        device_id: deviceId,
        raw_serial_number: cleanSn,
        device_user_id: 'COMMAND',
        event_timestamp: new Date().toISOString(),
        payload: { cmd: command, commandId, ...(options?.payload || {}) },
        processed: false,
      });

    if (insertErr) {
      console.warn('[Device Command Queue] Persisting command to DB failed:', insertErr.message);
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
  if (!schoolId) return { success: false, commandIds: [] };
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
  schoolId: string,
  knownDevices?: DeviceRecord[]
) {
  const devices = knownDevices ?? await getActiveDevicesForSchool(schoolId);
  if (devices.some(device => device.school_id !== schoolId)) {
    return { success: false, queuedCount: 0, totalDevices: devices.length, message: 'A target device belongs to a different school.' };
  }
  if (devices.length === 0) {
    return { success: false, queuedCount: 0, totalDevices: 0, message: 'No active devices registered.' };
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
