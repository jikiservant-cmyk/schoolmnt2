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

    if (staffData?.people?.school_id) {
      return staffData.people.school_id;
    }
  } catch (err) {
    console.warn('Error resolving via staff_users:', err);
  }

  // 3. Fallback to existing school record in the school schema
  try {
    const adminClient = createAdminClient();
    const { data: school } = await adminClient
      .from('schools')
      .select('id')
      .limit(1)
      .maybeSingle();

    if (school?.id) {
      return school.id;
    }

    // 4. If no school exists at all, bootstrap default school
    const { data: newSchool } = await adminClient
      .from('schools')
      .insert({
        name: 'Meridian Academy',
        attendance_mode: 'both',
        timezone: 'Africa/Kampala',
        settings: { late_after: '07:45', send_sms_on_present: true }
      })
      .select('id')
      .single();

    return newSchool?.id || null;
  } catch (err) {
    console.error('Error resolving fallback school:', err);
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

export async function pushAllUsersToDeviceAction(deviceSerialNumber?: string) {
  try {
    const adminClient = createAdminClient();

    // Fetch all people with a device_user_id (PIN) and their role/class info
    const { data: people, error } = await adminClient
      .from('people')
      .select(`
        id,
        full_name,
        role,
        device_user_id,
        classes:class_id(name)
      `)
      .not('device_user_id', 'is', null);

    if (error) {
      console.error('Failed to fetch people for device sync:', error);
      return { error: 'Failed to fetch enrolled people.' };
    }

    if (!people || people.length === 0) {
      return { success: true, count: 0, message: 'No people have a Device User ID (PIN) configured.' };
    }

    const { enqueueDeviceCommand } = await import('@/utils/zkteco/commandQueue');
    const { formatZKTecoDisplayName } = await import('@/utils/zkteco/formatter');

    let queuedCount = 0;
    for (const p of people) {
      if (!p.device_user_id) continue;
      const displayName = formatZKTecoDisplayName({
        full_name: p.full_name,
        role: p.role as any,
        classes: p.classes as any
      });

      // ZKTeco ADMS command to update user name on terminal
      // DATA UPDATE userinfo PIN=7001\tName=John Doe (7A)\tPri=0
      const pri = p.role === 'teacher' ? 0 : 0; // 0=Normal User, 14=Admin
      const cmd = `DATA UPDATE userinfo PIN=${p.device_user_id}\tName=${displayName}\tPri=${pri}`;
      enqueueDeviceCommand(cmd, deviceSerialNumber);
      queuedCount++;
    }

    return {
      success: true,
      count: queuedCount,
      message: `Enqueued ${queuedCount} user profile & name sync commands to biometric terminal(s).`
    };
  } catch (err: any) {
    console.error('Error pushing users to device:', err);
    return { error: err?.message || 'An unexpected error occurred during sync.' };
  }
}

