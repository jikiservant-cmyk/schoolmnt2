'use server';

import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { revalidatePath } from 'next/cache';

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
  const rawSecret = (formData.get('deviceSecret') as string)?.trim() || null;
  const lateCutoff = (formData.get('lateCutoff') as string)?.trim() || '08:00';
  const timeZone = (formData.get('timeZone') as string)?.trim() || 'Africa/Kampala';

  if (!serialNumber || !serialNumber.trim()) {
    return { error: 'Device Serial Number is required.' };
  }

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    
    if (!user) {
      return { error: 'Not authenticated. Please log in.' };
    }

    const schoolId = await resolveSchoolId(supabase, user.id);
    if (!schoolId) {
      return { error: 'School tenant context could not be resolved. Please try refreshing.' };
    }

    const adminClient = createAdminClient();

    // Check if device serial already exists
    const cleanSerial = serialNumber.trim().toUpperCase();
    const { data: existingDevice } = await adminClient
      .from('devices')
      .select('id, serial_number')
      .eq('serial_number', cleanSerial)
      .maybeSingle();

    if (existingDevice) {
      return { error: `Device with Serial Number "${cleanSerial}" is already registered.` };
    }

    const { generateDeviceSecret, hashDeviceSecret, packDeviceMetadata } = await import('@/lib/devices/metadata');
    const secretToSave = rawSecret || generateDeviceSecret();
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
        device_secret: secretToSave,
        device_secret_hash: secretHashToSave,
        config
      });

    // 2. Fallback if device_secret column is not present or metadata packing is needed
    if (insertErr && (insertErr.code === 'PGRST204' || insertErr.message?.includes('column'))) {
      const retryWithoutSecret = await adminClient
        .from('devices')
        .insert({
          ...baseRecord,
          firmware_version: 'Ver 2.0.1-20170210',
          device_type: deviceType,
          device_secret_hash: secretHashToSave,
          config
        });

      if (!retryWithoutSecret.error) {
        insertErr = null;
      } else {
        const packedFw = packDeviceMetadata('Ver 2.0.1-20170210', {
          type: deviceType as any,
          secret: secretToSave,
          config
        });

        const retryPacked = await adminClient
          .from('devices')
          .insert({
            ...baseRecord,
            firmware_version: packedFw
          });
        insertErr = retryPacked.error;
      }
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
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: 'Not authenticated.' };

    const schoolId = await resolveSchoolId(supabase, user.id);
    if (!schoolId) return { error: 'School context could not be resolved.' };

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

    // Attempt update with device_secret_hash first
    let { error: updateErr } = await adminClient
      .from('devices')
      .update({ 
        device_secret_hash: newSecretHash,
        device_secret: newSecret 
      })
      .eq('id', deviceId);

    if (updateErr && (updateErr.code === 'PGRST204' || updateErr.message?.includes('column'))) {
      const retryHashOnly = await adminClient
        .from('devices')
        .update({ device_secret_hash: newSecretHash })
        .eq('id', deviceId);

      if (!retryHashOnly.error) {
        updateErr = null;
      } else {
        const packedFw = packDeviceMetadata(dev.firmware_version, {
          type: parsed.device_type,
          secret: newSecret,
          config: parsed.config
        });
        const retryPacked = await adminClient
          .from('devices')
          .update({ firmware_version: packedFw })
          .eq('id', deviceId);
        updateErr = retryPacked.error;
      }
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
    const adminClient = createAdminClient();
    const { deviceSerialNumber, category, classId } = options;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return { error: 'Not authenticated.' };
    }

    const schoolId = await resolveSchoolId(supabase, user.id);
    if (!schoolId) {
      return { error: 'No school tenant found for the current user.' };
    }

    let schoolName = 'Connected School';

    if (deviceSerialNumber && deviceSerialNumber.trim()) {
      const cleanSerial = deviceSerialNumber.trim();
      const { data: deviceRecord } = await adminClient
        .from('devices')
        .select('id, serial_number, school_id, schools:school_id(name)')
        .eq('school_id', schoolId)
        .ilike('serial_number', cleanSerial)
        .maybeSingle();

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
      .order('full_name');

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

    const { data: people, error } = await query;
    if (error) {
      console.error('Error fetching push candidates:', error);
      return { error: error.message || 'Failed to fetch candidate people.' };
    }

    const { formatZKTecoDisplayName } = await import('@/utils/zkteco/formatter');

    const formattedCandidates = (people || []).map((p: any) => ({
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
    const adminClient = createAdminClient();
    const { deviceSerialNumber, category = 'all', classId } = options;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return { error: 'Not authenticated.' };
    }

    const schoolId = await resolveSchoolId(supabase, user.id);
    if (!schoolId) {
      return { error: 'Could not determine the school context for this device push.' };
    }

    let schoolName = 'Connected School';

    // 1. Resolve school from the target device to guarantee multi-tenant scoping
    if (deviceSerialNumber && deviceSerialNumber.trim()) {
      const cleanSerial = deviceSerialNumber.trim();
      const { data: deviceRecord } = await adminClient
        .from('devices')
        .select('id, serial_number, school_id, schools:school_id(name)')
        .eq('school_id', schoolId)
        .ilike('serial_number', cleanSerial)
        .maybeSingle();

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
      .order('full_name');

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
        const { data: cls } = await adminClient
          .from('classes')
          .select('name')
          .eq('id', classId)
          .maybeSingle();
        targetClassName = cls?.name || 'Selected Class';
        categoryLabel = `Class "${targetClassName}" Students`;
      } else {
        categoryLabel = 'Class Students';
      }
    }

    const { data: people, error } = await query;

    if (error) {
      console.error('Failed to fetch people for device sync:', error);
      return { error: error.message || 'Failed to fetch enrolled people.' };
    }

    if (!people || people.length === 0) {
      return { 
        success: true, 
        count: 0, 
        schoolName,
        categoryLabel,
        message: `No ${categoryLabel.toLowerCase()} with a Device User ID (PIN) found in ${schoolName}.` 
      };
    }

    const { enqueueDeviceCommand, enqueuePersonEnrollmentForSchool } = await import('@/utils/zkteco/commandQueue');
    const { getDeviceAdapter } = await import('@/lib/devices/registry');
    const { parseDeviceMetadata } = await import('@/lib/devices/metadata');

    let targetAdapter: any = null;
    let targetDevice: any = null;

    if (deviceSerialNumber && deviceSerialNumber.trim()) {
      const cleanSerial = deviceSerialNumber.trim().toUpperCase();
      const { data: devRow } = await adminClient
        .from('devices')
        .select('*')
        .eq('school_id', schoolId)
        .ilike('serial_number', cleanSerial)
        .maybeSingle();

      if (devRow) {
        targetDevice = parseDeviceMetadata(devRow);
        targetAdapter = getDeviceAdapter(targetDevice.device_type);
      }
    }

    let queuedCount = 0;
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
          await enqueueDeviceCommand(enrollCmd.command, targetDevice.serial_number);
          queuedCount++;
        }
      } else {
        // Broadcast to all devices owned by school with dynamic per-vendor translation
        const res = await enqueuePersonEnrollmentForSchool(enrollInput, schoolId);
        if (res.success) {
          queuedCount += res.queuedCount;
        }
      }

      if (previewList.length < 12) {
        const vendorLabel = targetAdapter ? targetAdapter.displayName : 'Multi-Vendor';
        previewList.push(`${p.device_user_id}: ${p.full_name} (${vendorLabel})`);
      }
    }

    revalidatePath('/dashboard/devices');

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
    const adminClient = createAdminClient();
    const { deviceSerialNumber, category = 'all', classId } = options;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return { error: 'Not authenticated.' };
    }

    const schoolId = await resolveSchoolId(supabase, user.id);
    if (!schoolId) {
      return { error: 'Could not determine school context.' };
    }

    let schoolName = 'Connected School';

    if (deviceSerialNumber && deviceSerialNumber.trim()) {
      const cleanSerial = deviceSerialNumber.trim();
      const { data: deviceRecord } = await adminClient
        .from('devices')
        .select('id, serial_number, school_id, schools:school_id(name)')
        .eq('school_id', schoolId)
        .ilike('serial_number', cleanSerial)
        .maybeSingle();

      if (!deviceRecord) {
        return { error: 'Device not found or access denied.' };
      }
      
      schoolName = (deviceRecord.schools as any)?.name || schoolName;
    }

    // 1. Fetch all people in school to find highest existing numeric PIN
    const { data: allSchoolPeople } = await adminClient
      .from('people')
      .select('device_user_id')
      .eq('school_id', schoolId);

    const existingPins = new Set<string>();
    let maxNumericPin = 100;

    (allSchoolPeople || []).forEach(p => {
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
      .order('full_name');

    if (category === 'teachers') {
      query = query.in('role', ['teacher', 'admin']);
    } else if (category === 'support_staff') {
      query = query.eq('role', 'support_staff');
    } else if (category === 'all_students') {
      query = query.eq('role', 'student');
    } else if (category === 'class' && classId) {
      query = query.eq('role', 'student').eq('class_id', classId);
    }

    const { data: unassignedPeople, error: fetchErr } = await query;
    if (fetchErr) {
      return { error: fetchErr.message || 'Failed to fetch unassigned members.' };
    }

    if (!unassignedPeople || unassignedPeople.length === 0) {
      return { success: true, count: 0, message: 'All selected members already have a biometric PIN assigned.' };
    }

    const { enqueueDeviceCommand, enqueueDeviceCommandForSchool } = await import('@/utils/zkteco/commandQueue');
    const { formatZKTecoDisplayName } = await import('@/utils/zkteco/formatter');

    let currentPinNum = maxNumericPin;
    let assignedCount = 0;

    for (const p of unassignedPeople) {
      // Find next free PIN
      do {
        currentPinNum++;
      } while (existingPins.has(String(currentPinNum)));

      const assignedPin = String(currentPinNum).replace(/[\t\r\n=]/g, '');
      existingPins.add(assignedPin);

      // Update in DB
      await adminClient
        .from('people')
        .update({ device_user_id: assignedPin })
        .eq('id', p.id);

      // Enqueue sync command to terminal
      const displayName = formatZKTecoDisplayName({
        full_name: p.full_name,
        role: p.role as any,
        classes: p.classes as any
      });

      const pri = p.role === 'admin' ? 14 : 0;
      const cmd = `DATA UPDATE userinfo PIN=${assignedPin}\tName=${displayName}\tPri=${pri}`;
      if (deviceSerialNumber) {
        await enqueueDeviceCommand(cmd, deviceSerialNumber);
      } else {
        await enqueueDeviceCommandForSchool(cmd, schoolId);
      }

      assignedCount++;
    }

    revalidatePath('/dashboard/devices');
    revalidatePath('/dashboard/people');

    return {
      success: true,
      count: assignedCount,
      message: `Assigned sequential PINs to ${assignedCount} members and enqueued display names to terminal.`
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

