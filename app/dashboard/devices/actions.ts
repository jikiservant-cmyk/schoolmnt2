'use server';

import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { requireSchoolAdmin } from '@/lib/auth-guard';
import { revalidatePath } from 'next/cache';
import { normalizeDeviceSerialNumber } from '@/lib/devices/serial';
import { SUPPORTED_DEVICE_TYPES } from '@/lib/devices/registry';

async function resolveSchoolId(supabase: any, userId: string): Promise<string | null> {
  // 1. Try auth_school_id RPC
  try {
    const { data: rpcSchoolId } = await supabase.rpc('auth_school_id');
    if (rpcSchoolId) return rpcSchoolId;
  } catch (err) {
    console.warn('RPC auth_school_id failed:', err);
  }

  // 2. Try staff_users linked via person_id -> people -> school_id
  try {
    const { data: staffData } = await supabase
      .from('staff_users')
      .select('person_id, people(school_id)')
      .eq('auth_user_id', userId)
      .maybeSingle();

    const peopleObj = Array.isArray(staffData?.people) ? staffData.people[0] : staffData?.people;
    const resolvedSchoolId = (peopleObj as any)?.school_id;
    if (resolvedSchoolId) {
      return resolvedSchoolId;
    }
  } catch (err) {
    console.warn('Error resolving via staff_users:', err);
  }

  return null;
}

export async function addDeviceAction(formData: FormData) {
  const serialNumber = formData.get('serialNumber') as string;
  const label = formData.get('label') as string;
  const ipAddress = (formData.get('ipAddress') as string) || null;
  const deviceType = ((formData.get('deviceType') as string) || 'zkteco_adms').trim();
  const lateCutoff = (formData.get('lateCutoff') as string)?.trim() || '08:00';
  const timeZone = (formData.get('timeZone') as string)?.trim() || 'Africa/Kampala';

  const cleanSerial = normalizeDeviceSerialNumber(serialNumber);
  if (!cleanSerial) {
    return { error: 'Enter a valid device serial number (letters, digits, dot, underscore, colon, or hyphen).' };
  }
  if (!SUPPORTED_DEVICE_TYPES.some(option => option.type === deviceType)) {
    return { error: 'Select a supported biometric device protocol.' };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(lateCutoff)) {
    return { error: 'Choose a valid late cutoff time.' };
  }
  const supportedTimeZones = new Set([
    'Africa/Kampala',
    'Africa/Nairobi',
    'Africa/Kigali',
    'Africa/Dar_es_Salaam',
    'UTC',
  ]);
  if (!supportedTimeZones.has(timeZone)) {
    return { error: 'Choose a supported time zone.' };
  }

  try {
    const { schoolId } = await requireSchoolAdmin();
    const adminClient = createAdminClient();

    // Check if device serial already exists
    const { data: existingDevice, error: deviceLookupError } = await adminClient
      .from('devices')
      .select('id, serial_number')
      .eq('serial_number', cleanSerial)
      .maybeSingle();

    if (deviceLookupError) {
      console.error('Could not verify device serial uniqueness:', deviceLookupError);
      return { error: 'Could not verify whether this device is already registered. Please retry.' };
    }
    if (existingDevice) {
      return { error: `Device with Serial Number "${cleanSerial}" is already registered.` };
    }

    const { generateDeviceSecret, hashDeviceSecret, packDeviceMetadata } = await import('@/lib/devices/metadata');
    // Generate credentials on the server so no client-controlled or weak token is trusted.
    const secretToSave = generateDeviceSecret();
    const secretHashToSave = hashDeviceSecret(secretToSave);

    const [lateH, lateM] = lateCutoff.split(':').map(n => parseInt(n, 10));
    const config = {
      lateCutoffHour: isNaN(lateH) ? 8 : lateH,
      lateCutoffMinute: isNaN(lateM) ? 0 : lateM,
      timeZone: timeZone || 'Africa/Kampala',
    };

    const baseRecord = {
      school_id: schoolId,
      serial_number: cleanSerial,
      label: label ? label.trim() : `Terminal (${cleanSerial})`,
      location_label: label ? label.trim() : `Terminal (${cleanSerial})`,
      ip_address: ipAddress ? ipAddress.trim() : null,
      is_active: true,
      last_seen_at: null
    };

    // 1. Attempt insert with dedicated columns according to new DB schema
    let { error: insertErr } = await adminClient
      .from('devices')
      .insert({
        ...baseRecord,
        firmware_version: 'Ver 2.0.1-20170210',
        device_type: deviceType,
        device_secret_hash: secretHashToSave,
        config
      });

    // Compatibility path for installations that have the legacy device_secret
    // column but have not yet applied the hash/config-column migration. Store the
    // SHA-256 digest in that column; never persist the raw token.
    if (insertErr && (insertErr.code === 'PGRST204' || insertErr.message?.toLowerCase().includes('column'))) {
      const packedFw = packDeviceMetadata('Ver 2.0.1-20170210', {
        type: deviceType as any,
        config
      });

      const retryLegacy = await adminClient
        .from('devices')
        .insert({
          ...baseRecord,
          device_secret: secretHashToSave,
          firmware_version: packedFw
        });
      insertErr = retryLegacy.error;
    }

    if (insertErr) {
      console.error('Failed to insert device:', insertErr);
      if (insertErr.code === '23505') {
        return { error: `Device Serial Number "${cleanSerial}" is already registered.` };
      }
      return { error: insertErr.message || 'Failed to register the biometric device.' };
    }

    revalidatePath('/dashboard/devices');
    return { success: true, deviceSecret: secretToSave };
  } catch (err: any) {
    console.error('Error in addDeviceAction:', err);
    return { error: err?.message || 'An unexpected error occurred while registering the device.' };
  }
}

export async function regenerateDeviceSecretAction(deviceId: string) {
  try {
    const { schoolId } = await requireSchoolAdmin();
    const adminClient = createAdminClient();
    const { data: dev, error: fetchErr } = await adminClient
      .from('devices')
      .select('*')
      .eq('id', deviceId)
      .eq('school_id', schoolId)
      .maybeSingle();

    if (fetchErr || !dev) return { error: 'Device not found.' };

    const { generateDeviceSecret, hashDeviceSecret, parseDeviceMetadata, packDeviceMetadata } = await import('@/lib/devices/metadata');
    const newSecret = generateDeviceSecret();
    const newSecretHash = hashDeviceSecret(newSecret);
    const parsed = parseDeviceMetadata(dev);

    // Store only a digest and remove any legacy raw secret from both the
    // dedicated column and packed firmware metadata.
    const packedFw = packDeviceMetadata(dev.firmware_version, {
      type: parsed.device_type,
      statusCodeMap: parsed.status_code_map,
      config: parsed.config,
    });
    let { error: updateErr } = await adminClient
      .from('devices')
      .update({ device_secret_hash: newSecretHash, device_secret: null, firmware_version: packedFw })
      .eq('id', deviceId)
      .eq('school_id', schoolId);

    if (updateErr && (updateErr.code === 'PGRST204' || updateErr.message?.toLowerCase().includes('column'))) {
      const retryLegacy = await adminClient
        .from('devices')
        .update({ device_secret: newSecretHash, firmware_version: packedFw })
        .eq('id', deviceId)
        .eq('school_id', schoolId);
      updateErr = retryLegacy.error;
    }

    if (updateErr) {
      return { error: updateErr.message || 'Failed to regenerate device secret.' };
    }

    revalidatePath('/dashboard/devices');
    return { success: true, newSecret };
  } catch (err: any) {
    return { error: err?.message || 'Failed to update token.' };
  }
}

export interface PushDeviceTargetOptions {
  deviceSerialNumber?: string;
  category: 'all' | 'teachers' | 'support_staff' | 'all_students' | 'class';
  classId?: string;
}

export async function getDevicePushCandidatesAction(options: PushDeviceTargetOptions) {
  try {
    const { schoolId } = await requireSchoolAdmin();
    const adminClient = createAdminClient();
    const { deviceSerialNumber, category, classId } = options;

    let schoolName = 'Connected School';

    if (deviceSerialNumber !== undefined) {
      const cleanSerial = normalizeDeviceSerialNumber(deviceSerialNumber);
      if (!cleanSerial) return { error: 'Invalid device serial number.' };
      const { data: deviceRecord, error: deviceLookupError } = await adminClient
        .from('devices')
        .select('id, serial_number, school_id, schools:school_id(name)')
        .eq('school_id', schoolId)
        .eq('serial_number', cleanSerial)
        .maybeSingle();

      if (deviceLookupError) return { error: 'Could not verify the selected device.' };
      if (!deviceRecord) {
        return { error: 'Device not found or access denied.' };
      }
      
      schoolName = (deviceRecord.schools as any)?.name || schoolName;
    }

    let query = adminClient
      .from('people')
      .select(`
        id,
        full_name,
        role,
        device_user_id,
        class_id,
        classes:class_id(id, name)
      `)
      .eq('school_id', schoolId)
      .neq('is_active', false)
      .order('full_name')
      .order('id');

    if (category === 'teachers') {
      query = query.in('role', ['teacher', 'admin']);
    } else if (category === 'support_staff') {
      query = query.eq('role', 'support_staff');
    } else if (category === 'all_students') {
      query = query.eq('role', 'student');
    } else if (category === 'class') {
      query = query.eq('role', 'student');
      if (classId) {
        query = query.eq('class_id', classId);
      }
    }

    const people: any[] = [];
    const pageSize = 500;
    for (let from = 0; ; from += pageSize) {
      const { data: peoplePage, error } = await query.range(from, from + pageSize - 1);
      if (error) {
        console.error('Error fetching push candidates:', error);
        return { error: 'Failed to fetch all candidate people.' };
      }
      people.push(...(peoplePage || []));
      if (!peoplePage || peoplePage.length < pageSize) break;
    }

    const { formatZKTecoDisplayName } = await import('@/utils/zkteco/formatter');

    const formattedCandidates = people.map((p: any) => ({
      id: p.id,
      full_name: p.full_name,
      role: p.role,
      device_user_id: p.device_user_id,
      className: p.classes?.name || null,
      formattedName: formatZKTecoDisplayName({
        full_name: p.full_name,
        role: p.role,
        classes: p.classes
      })
    }));

    const withPin = formattedCandidates.filter(p => !!p.device_user_id);
    const withoutPin = formattedCandidates.filter(p => !p.device_user_id);

    return {
      success: true,
      schoolId,
      schoolName,
      totalCount: formattedCandidates.length,
      withPinCount: withPin.length,
      withoutPinCount: withoutPin.length,
      candidates: formattedCandidates
    };
  } catch (err: any) {
    console.error('Error in getDevicePushCandidatesAction:', err);
    return { error: err?.message || 'Failed to calculate candidates.' };
  }
}

export async function pushUsersToDeviceAction(options: PushDeviceTargetOptions) {
  try {
    const { schoolId } = await requireSchoolAdmin();
    const adminClient = createAdminClient();
    const { deviceSerialNumber, category = 'all', classId } = options;

    let schoolName = 'Connected School';

    // 1. Resolve school from the target device to guarantee multi-tenant scoping
    if (deviceSerialNumber !== undefined && deviceSerialNumber !== '') {
      const cleanSerial = normalizeDeviceSerialNumber(deviceSerialNumber);
      if (!cleanSerial) return { error: 'Invalid device serial number.' };
      const { data: deviceRecord, error: deviceLookupError } = await adminClient
        .from('devices')
        .select('id, serial_number, school_id, schools:school_id(name)')
        .eq('school_id', schoolId)
        .eq('serial_number', cleanSerial)
        .maybeSingle();

      if (deviceLookupError) return { error: 'Could not verify the selected device.' };
      if (!deviceRecord) {
        return { error: 'Device not found or access denied.' };
      }
      
      schoolName = (deviceRecord.schools as any)?.name || schoolName;
    }

    // 3. Query people strictly scoped to this school_id
    let query = adminClient
      .from('people')
      .select(`
        id,
        full_name,
        role,
        device_user_id,
        class_id,
        classes:class_id(id, name)
      `)
      .eq('school_id', schoolId)
      .neq('is_active', false)
      .not('device_user_id', 'is', null)
      .order('full_name')
      .order('id');

    let categoryLabel = 'All School Members';
    let targetClassName: string | null = null;

    if (category === 'teachers') {
      query = query.in('role', ['teacher', 'admin']);
      categoryLabel = 'Teachers & Faculty';
    } else if (category === 'support_staff') {
      query = query.eq('role', 'support_staff');
      categoryLabel = 'Support Staff';
    } else if (category === 'all_students') {
      query = query.eq('role', 'student');
      categoryLabel = 'All Students';
    } else if (category === 'class') {
      query = query.eq('role', 'student');
      if (classId) {
        query = query.eq('class_id', classId);
        // Find class name for nice label
        const { data: cls, error: classLookupError } = await adminClient
          .from('classes')
          .select('name')
          .eq('id', classId)
          .eq('school_id', schoolId)
          .maybeSingle();
        if (classLookupError) return { error: 'Could not verify the selected class.' };
        targetClassName = cls?.name || 'Selected Class';
        categoryLabel = `Class "${targetClassName}" Students`;
      } else {
        categoryLabel = 'Class Students';
      }
    }

    const people: any[] = [];
    const peoplePageSize = 500;
    for (let from = 0; ; from += peoplePageSize) {
      const { data: peoplePage, error } = await query.range(from, from + peoplePageSize - 1);
      if (error) {
        console.error('Failed to fetch people for device sync:', error);
        return { error: error.message || 'Failed to fetch enrolled people.' };
      }
      people.push(...(peoplePage || []));
      if (!peoplePage || peoplePage.length < peoplePageSize) break;
    }

    if (people.length === 0) {
      return { 
        success: true, 
        count: 0, 
        schoolName,
        categoryLabel,
        message: `No ${categoryLabel.toLowerCase()} with a Device User ID (PIN) found in ${schoolName}.` 
      };
    }

    const { enqueueDeviceCommand, enqueuePersonEnrollmentForSchool, getActiveDevicesForSchool } = await import('@/utils/zkteco/commandQueue');
    const { getDeviceAdapter } = await import('@/lib/devices/registry');
    const { parseDeviceMetadata } = await import('@/lib/devices/metadata');

    let targetAdapter: any = null;
    let targetDevice: any = null;

    if (deviceSerialNumber !== undefined && deviceSerialNumber !== '') {
      const cleanSerial = normalizeDeviceSerialNumber(deviceSerialNumber);
      if (!cleanSerial) return { error: 'Invalid device serial number.' };
      const { data: devRow, error: deviceLookupError } = await adminClient
        .from('devices')
        .select('*')
        .eq('school_id', schoolId)
        .eq('serial_number', cleanSerial)
        .maybeSingle();

      if (deviceLookupError) return { error: 'Could not verify the selected device.' };
      if (!devRow) return { error: 'Device not found or access denied.' };
      targetDevice = parseDeviceMetadata(devRow);
      targetAdapter = getDeviceAdapter(targetDevice.device_type);
    }

    const schoolDevices = targetDevice ? [] : await getActiveDevicesForSchool(schoolId);
    if (!targetDevice && schoolDevices.length === 0) {
      return { error: 'No active devices are registered to this school; no enrollment commands were queued.' };
    }

    let queuedCount = 0;
    const enqueueFailures: string[] = [];
    const previewList: string[] = [];

    for (const p of people) {
      if (!p.device_user_id || !p.device_user_id.trim()) continue;

      const enrollInput = {
        pin: p.device_user_id.trim(),
        fullName: p.full_name,
        role: p.role as any,
        className: (p.classes as any)?.name || null
      };

      if (targetDevice && targetAdapter) {
        const enrollCmd = targetAdapter.buildEnrollCommand(enrollInput, targetDevice);
        if (enrollCmd.transportType === 'adms_command' || enrollCmd.transportType === 'rest_api') {
          const enqueueResult = await enqueueDeviceCommand(enrollCmd.command, targetDevice.serial_number, { schoolId });
          if (enqueueResult.success) queuedCount++;
          else enqueueFailures.push(p.full_name);
        } else {
          enqueueFailures.push(p.full_name);
        }
      } else {
        // Reuse the one school-scoped device lookup for this entire roster sync.
        const res = await enqueuePersonEnrollmentForSchool(enrollInput, schoolId, schoolDevices);
        queuedCount += res.queuedCount;
        if (!res.success || res.queuedCount !== res.totalDevices) {
          enqueueFailures.push(p.full_name);
        }
      }

      if (previewList.length < 12) {
        const vendorLabel = targetAdapter ? targetAdapter.displayName : 'Multi-Vendor';
        previewList.push(`${p.device_user_id}: ${p.full_name} (${vendorLabel})`);
      }
    }

    revalidatePath('/dashboard/devices');

    if (enqueueFailures.length > 0) {
      const failedNames = enqueueFailures.slice(0, 5).join(', ');
      const omittedCount = Math.max(0, enqueueFailures.length - 5);
      return {
        success: false,
        count: queuedCount,
        schoolName,
        categoryLabel,
        previewList,
        error: `Queued ${queuedCount} enrollment payload(s), but sync failed for ${enqueueFailures.length} member(s): ${failedNames}${omittedCount ? ` and ${omittedCount} more` : ''}. Retry the failed enrollments.`,
      };
    }

    return {
      success: true,
      count: queuedCount,
      schoolName,
      categoryLabel,
      previewList,
      message: `Enqueued ${queuedCount} enrollment payload(s) (${categoryLabel}) for ${schoolName}.`
    };
  } catch (err: any) {
    console.error('Error pushing users to device:', err);
    return { error: err?.message || 'An unexpected error occurred during sync.' };
  }
}

/**
 * Automatically assigns sequential Biometric PINs (Device User IDs) to members missing a PIN and enqueues sync commands
 */
export async function autoAssignDevicePinsAction(options: PushDeviceTargetOptions) {
  try {
    const { schoolId } = await requireSchoolAdmin();
    const adminClient = createAdminClient();
    const { deviceSerialNumber, category = 'all', classId } = options;

    let schoolName = 'Connected School';

    if (deviceSerialNumber !== undefined && deviceSerialNumber !== '') {
      const cleanSerial = normalizeDeviceSerialNumber(deviceSerialNumber);
      if (!cleanSerial) return { error: 'Invalid device serial number.' };
      const { data: deviceRecord } = await adminClient
        .from('devices')
        .select('id, serial_number, school_id, schools:school_id(name)')
        .eq('school_id', schoolId)
        .eq('serial_number', cleanSerial)
        .maybeSingle();

      if (!deviceRecord) {
        return { error: 'Device not found or access denied.' };
      }
      
      schoolName = (deviceRecord.schools as any)?.name || schoolName;
    }

    // 1. Fetch all people in school to find highest existing numeric PIN
    const allSchoolPeople: Array<{ device_user_id: string | null }> = [];
    const pinPageSize = 500;
    for (let from = 0; ; from += pinPageSize) {
      const { data: peoplePage, error: existingPinsError } = await adminClient
        .from('people')
        .select('device_user_id')
        .eq('school_id', schoolId)
        .order('id')
        .range(from, from + pinPageSize - 1);

      if (existingPinsError) {
        console.error('Failed to load existing school PINs:', existingPinsError);
        return { error: 'Could not verify existing biometric PINs; no new PINs were assigned.' };
      }
      allSchoolPeople.push(...(peoplePage || []));
      if (!peoplePage || peoplePage.length < pinPageSize) break;
    }

    const existingPins = new Set<string>();
    let maxNumericPin = 100;

    allSchoolPeople.forEach(p => {
      if (p.device_user_id) {
        existingPins.add(p.device_user_id.trim());
        const num = parseInt(p.device_user_id.trim(), 10);
        if (!isNaN(num) && num > maxNumericPin && num < 99999) {
          maxNumericPin = num;
        }
      }
    });

    // 2. Query people missing PIN in the targeted category
    let query = adminClient
      .from('people')
      .select(`
        id,
        full_name,
        role,
        device_user_id,
        class_id,
        classes:class_id(id, name)
      `)
      .eq('school_id', schoolId)
      .is('device_user_id', null)
      .neq('is_active', false)
      .order('full_name')
      .order('id');

    if (category === 'teachers') {
      query = query.in('role', ['teacher', 'admin']);
    } else if (category === 'support_staff') {
      query = query.eq('role', 'support_staff');
    } else if (category === 'all_students') {
      query = query.eq('role', 'student');
    } else if (category === 'class' && classId) {
      query = query.eq('role', 'student').eq('class_id', classId);
    }

    const unassignedPeople: any[] = [];
    const peoplePageSize = 500;
    for (let from = 0; ; from += peoplePageSize) {
      const { data: peoplePage, error: fetchErr } = await query.range(from, from + peoplePageSize - 1);
      if (fetchErr) {
        return { error: fetchErr.message || 'Failed to fetch unassigned members.' };
      }
      unassignedPeople.push(...(peoplePage || []));
      if (!peoplePage || peoplePage.length < peoplePageSize) break;
    }

    if (unassignedPeople.length === 0) {
      return { success: true, count: 0, message: 'All selected members already have a biometric PIN assigned.' };
    }

    const { enqueueDeviceCommand, enqueueDeviceCommandForSchool } = await import('@/utils/zkteco/commandQueue');
    const { formatZKTecoDisplayName } = await import('@/utils/zkteco/formatter');

    let currentPinNum = maxNumericPin;
    let assignedCount = 0;
    let queueFailureCount = 0;

    for (const p of unassignedPeople) {
      // Find next free PIN
      do {
        currentPinNum++;
      } while (existingPins.has(String(currentPinNum)));

      const assignedPin = String(currentPinNum).replace(/[\t\r\n=]/g, '');
      existingPins.add(assignedPin);

      // Update in DB
      const { error: pinUpdateError } = await adminClient
        .from('people')
        .update({ device_user_id: assignedPin })
        .eq('id', p.id)
        .eq('school_id', schoolId);
      if (pinUpdateError) {
        console.error('Failed to assign biometric PIN to school member:', pinUpdateError);
        return { error: 'Failed to save an assigned biometric ID. No device command was queued for that member.' };
      }

      // Enqueue sync command to terminal
      const displayName = formatZKTecoDisplayName({
        full_name: p.full_name,
        role: p.role as any,
        classes: p.classes as any
      });

      const pri = p.role === 'admin' ? 14 : 0;
      const cmd = `DATA UPDATE userinfo PIN=${assignedPin}\tName=${displayName}\tPri=${pri}`;
      const enqueueResult = deviceSerialNumber
        ? await enqueueDeviceCommand(cmd, deviceSerialNumber, { schoolId })
        : await enqueueDeviceCommandForSchool(cmd, schoolId);
      if (!enqueueResult.success) queueFailureCount++;

      assignedCount++;
    }

    revalidatePath('/dashboard/devices');
    revalidatePath('/dashboard/people');

    if (queueFailureCount > 0) {
      return {
        success: false,
        count: assignedCount,
        error: `Assigned PINs to ${assignedCount} member(s), but failed to queue device sync for ${queueFailureCount}. Use Push User Names to retry the device sync.`,
      };
    }

    return {
      success: true,
      count: assignedCount,
      message: `Assigned sequential PINs to ${assignedCount} members and queued display names to terminal.`
    };
  } catch (err: any) {
    console.error('Error auto-assigning PINs:', err);
    return { error: err?.message || 'Failed to auto-assign biometric PINs.' };
  }
}

// Backward-compatible alias
export async function pushAllUsersToDeviceAction(deviceSerialNumber?: string) {
  return pushUsersToDeviceAction({
    deviceSerialNumber,
    category: 'all'
  });
}

