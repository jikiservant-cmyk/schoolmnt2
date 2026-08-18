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

    // Insert device record into school.devices
    const { error: insertErr } = await adminClient
      .from('devices')
      .insert({
        school_id: schoolId,
        serial_number: cleanSerial,
        label: label ? label.trim() : 'ZKTeco F18 Terminal',
        ip_address: ipAddress ? ipAddress.trim() : null,
        is_active: true,
        firmware_version: 'Ver 2.0.1-20170210',
        last_seen_at: null
      });

    if (insertErr) {
      console.error('Failed to insert device:', insertErr);
      if (insertErr.code === '23505') {
        return { error: `Device Serial Number "${cleanSerial}" is already registered.` };
      }
      return { error: insertErr.message || 'Failed to register the biometric device.' };
    }

    revalidatePath('/dashboard/devices');
    return { success: true };
  } catch (err: any) {
    console.error('Error in addDeviceAction:', err);
    return { error: err?.message || 'An unexpected error occurred while registering the device.' };
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

    let schoolId: string | null = null;
    let schoolName = 'Connected School';

    if (deviceSerialNumber && deviceSerialNumber.trim()) {
      const cleanSerial = deviceSerialNumber.trim();
      const { data: deviceRecord } = await adminClient
        .from('devices')
        .select('id, serial_number, school_id, schools:school_id(name)')
        .ilike('serial_number', cleanSerial)
        .maybeSingle();

      if (deviceRecord?.school_id) {
        schoolId = deviceRecord.school_id;
        schoolName = (deviceRecord.schools as any)?.name || schoolName;
      }
    }

    if (!schoolId) {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        schoolId = await resolveSchoolId(supabase, user.id);
      }
    }

    if (!schoolId) {
      return { error: 'No school tenant found for this device.' };
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

    let schoolId: string | null = null;
    let schoolName = 'Connected School';

    // 1. Resolve school from the target device to guarantee multi-tenant scoping
    if (deviceSerialNumber && deviceSerialNumber.trim()) {
      const cleanSerial = deviceSerialNumber.trim();
      const { data: deviceRecord } = await adminClient
        .from('devices')
        .select('id, serial_number, school_id, schools:school_id(name)')
        .ilike('serial_number', cleanSerial)
        .maybeSingle();

      if (deviceRecord?.school_id) {
        schoolId = deviceRecord.school_id;
        schoolName = (deviceRecord.schools as any)?.name || schoolName;
      }
    }

    // 2. Fallback to signed-in user's school if device has no explicit school_id
    if (!schoolId) {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        schoolId = await resolveSchoolId(supabase, user.id);
      }
    }

    if (!schoolId) {
      return { error: 'Could not determine the school context for this device push.' };
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

    const { enqueueDeviceCommand } = await import('@/utils/zkteco/commandQueue');
    const { formatZKTecoDisplayName } = await import('@/utils/zkteco/formatter');

    let queuedCount = 0;
    const previewList: string[] = [];

    for (const p of people) {
      if (!p.device_user_id || !p.device_user_id.trim()) continue;
      
      const displayName = formatZKTecoDisplayName({
        full_name: p.full_name,
        role: p.role as any,
        classes: p.classes as any
      });

      // ZKTeco ADMS command to update user info on terminal:
      // DATA UPDATE userinfo PIN=201\tName=Tr. Denis Mpungu\tPri=0
      const pri = p.role === 'admin' ? 14 : 0; // 0=Normal User, 14=Device Admin
      const cmd = `DATA UPDATE userinfo PIN=${p.device_user_id.trim()}\tName=${displayName}\tPri=${pri}`;
      
      await enqueueDeviceCommand(cmd, deviceSerialNumber);
      queuedCount++;

      if (previewList.length < 12) {
        previewList.push(`${p.device_user_id}: ${displayName}`);
      }
    }

    revalidatePath('/dashboard/devices');

    return {
      success: true,
      count: queuedCount,
      schoolName,
      categoryLabel,
      previewList,
      message: `Enqueued ${queuedCount} names (${categoryLabel}) to terminal screen for ${schoolName}.`
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

    let schoolId: string | null = null;
    let schoolName = 'Connected School';

    if (deviceSerialNumber && deviceSerialNumber.trim()) {
      const cleanSerial = deviceSerialNumber.trim();
      const { data: deviceRecord } = await adminClient
        .from('devices')
        .select('id, serial_number, school_id, schools:school_id(name)')
        .ilike('serial_number', cleanSerial)
        .maybeSingle();

      if (deviceRecord?.school_id) {
        schoolId = deviceRecord.school_id;
        schoolName = (deviceRecord.schools as any)?.name || schoolName;
      }
    }

    if (!schoolId) {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        schoolId = await resolveSchoolId(supabase, user.id);
      }
    }

    if (!schoolId) {
      return { error: 'Could not determine school context.' };
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

    const { enqueueDeviceCommand } = await import('@/utils/zkteco/commandQueue');
    const { formatZKTecoDisplayName } = await import('@/utils/zkteco/formatter');

    let currentPinNum = maxNumericPin;
    let assignedCount = 0;

    for (const p of unassignedPeople) {
      // Find next free PIN
      do {
        currentPinNum++;
      } while (existingPins.has(String(currentPinNum)));

      const assignedPin = String(currentPinNum);
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
      await enqueueDeviceCommand(cmd, deviceSerialNumber);

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

