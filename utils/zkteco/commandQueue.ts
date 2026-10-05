import { createAdminClient } from '@/utils/supabase/admin';
import { parseDeviceMetadata } from '@/lib/devices/metadata';
import { getDeviceAdapter } from '@/lib/devices/registry';
import { EnrollPersonInput } from '@/lib/devices/types';
import { UUID_RE, normalizeSerial } from '@/lib/tenant';

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
  /** REQUIRED: the tenant that owns the target device. */
  schoolId: string;
  commandType?: 'ENROLL_USER' | 'DELETE_USER' | 'SYNC_TIME' | 'REBOOT' | string;
  payload?: Record<string, any>;
  vendorProtocol?: string;
}

/**
 * Enqueues a command for a specific device serial number into school.device_commands.
 *
 * MULTI-TENANT: the target device is resolved with an exact serial match AND
 * the caller's school_id. Previously the device was looked up with
 * `.ilike(serial)` across ALL schools and the command inherited whatever
 * school that device belonged to — a crafted serial (or a wildcard such as
 * "%"/"_") could route enrollment commands, which carry names and PINs, into
 * another tenant's queue. Commands for devices the school does not own are
 * now refused, and the legacy device_logs fallback is always tagged with the
 * owning school_id (previously it had none).
 */
export async function enqueueDeviceCommand(
  command: string,
  deviceSerialNumber: string,
  options: EnqueueCommandOptions
): Promise<{ success: boolean; commandId: string }> {
  const commandId = `cmd_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const schoolId = options?.schoolId;

  if (!schoolId || !UUID_RE.test(schoolId)) {
    console.error('[Device Command Queue] Refusing command without a valid school context.');
    return { success: false, commandId };
  }

  // ADMS sends commands as newline-separated "C:<id>:<cmd>" lines; a CR/LF in
  // the text would smuggle extra commands (e.g. CLEAR ALL DATA) to the device.
  if (typeof command !== 'string' || !command.trim() || /[\r\n\0]/.test(command) || command.length > 4096) {
    console.error('[Device Command Queue] Refusing unsafe or empty device command.');
    return { success: false, commandId };
  }

  const isBroadcast = typeof deviceSerialNumber === 'string' && deviceSerialNumber.trim().toUpperCase() === 'ALL';
  const cleanSn = isBroadcast ? 'ALL' : normalizeSerial(deviceSerialNumber);
  if (!cleanSn) {
    console.warn('[Device Command Queue] Refusing command for malformed serial number.');
    return { success: false, commandId };
  }

  try {
    const admin = createAdminClient();
    let deviceId: string | null = null;
    let vendorProtocol: string = options?.vendorProtocol || 'zkteco_adms';

    if (!isBroadcast) {
      const { data: dev, error } = await admin
        .from('devices')
        .select('id, school_id, device_type')
        .eq('serial_number', cleanSn)
        .eq('school_id', schoolId)
        .maybeSingle();

      if (error || !dev) {
        console.warn(`[Device Command Queue] Device ${cleanSn} is not owned by school ${schoolId}; command refused.`);
        return { success: false, commandId };
      }
      deviceId = dev.id;
      if (dev.device_type) vendorProtocol = dev.device_type;
    }

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
    console.warn('[Device Command Queue] device_commands insert failed, trying scoped device_logs fallback:', cmdErr?.message);

    // Legacy fallback queue read by /iclock/getrequest — always tagged with the owning school.
    const { error: logErr } = await admin
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
    if (logErr) {
      console.warn('[Device Command Queue] device_logs fallback failed:', logErr.message);
      return { success: false, commandId };
    }
    return { success: true, commandId };
  } catch (e: any) {
    console.warn('[Device Command Queue] Could not persist command to DB:', e?.message || e);
    return { success: false, commandId };
  }
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
