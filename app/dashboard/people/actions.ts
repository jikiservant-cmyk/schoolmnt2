'use server';

import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';

async function getEffectiveSchoolId(supabase: any, userId?: string): Promise<string | null> {
  // 1. Try auth_school_id RPC
  try {
    const { data: rpcSchoolId } = await supabase.rpc('auth_school_id');
    if (rpcSchoolId) {
      return rpcSchoolId;
    }
  } catch (err) {
    console.warn('RPC auth_school_id not available:', err);
  }

  // 2. Try staff_users linked via person_id -> people(school_id)
  if (userId) {
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
      console.error('Error resolving staff_users school context:', err);
    }
  }

  return null;
}

export async function addPersonAction(formData: FormData) {
  const supabase = await createClient();
  const fullName = formData.get('fullName') as string;
  const role = formData.get('role') as 'student' | 'teacher' | 'support_staff';
  
  if (!fullName || !role) {
    return { error: 'Full Name and Role are required.' };
  }

  if (role !== 'student' && role !== 'teacher' && role !== 'support_staff') {
    return { error: 'Role selection must be Student, Teacher, or Support Staff.' };
  }

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return { error: 'Not authenticated. Please log in.' };
    }

    const schoolId = await getEffectiveSchoolId(supabase, user.id);
    if (!schoolId) {
      return { error: 'No school tenant found for this account. Please verify your staff credentials.' };
    }

    const adminClient = createAdminClient();
    const rawDeviceId = formData.get('deviceUserId') as string;
    const cleanDeviceId = rawDeviceId && rawDeviceId.trim() ? rawDeviceId.trim() : null;

    // Check for duplicate biometric device user ID in this school
    if (cleanDeviceId) {
      const { data: existingPerson } = await adminClient
        .from('people')
        .select('id, full_name, role')
        .eq('school_id', schoolId)
        .eq('device_user_id', cleanDeviceId)
        .maybeSingle();

      if (existingPerson) {
        return {
          error: `The biometric Enrollment ID "${cleanDeviceId}" is already registered to ${existingPerson.full_name} (${existingPerson.role}) in your school.`
        };
      }
    }

    // -------------------------------------------------------------
    // Branch 1: Support Staff Registration (direct table insert)
    // -------------------------------------------------------------
    if (role === 'support_staff') {
      const phone = (formData.get('phone') as string)?.trim() || null;

      const { data: newPerson, error: insertErr } = await adminClient
        .from('people')
        .insert({
          school_id: schoolId,
          full_name: fullName.trim(),
          role: 'support_staff',
          phone: phone,
          device_user_id: cleanDeviceId,
          is_active: true,
          class_id: null
        })
        .select()
        .single();

      if (insertErr) {
        console.error('Error inserting support staff into people table:', insertErr);
        if (insertErr.code === '23505') {
          return { error: 'The biometric Enrollment ID is already registered to another person in your school.' };
        }
        return { error: insertErr.message || 'Failed to register support staff member.' };
      }

      // Sync user to biometric device queue if device ID provided
      if (cleanDeviceId) {
        try {
          const { formatZKTecoDisplayName } = await import('@/utils/zkteco/formatter');
          const { enqueueDeviceCommand } = await import('@/utils/zkteco/commandQueue');
          const displayName = formatZKTecoDisplayName({
            full_name: fullName.trim(),
            role: 'support_staff',
            classes: null
          });
          await enqueueDeviceCommand(`DATA UPDATE userinfo PIN=${cleanDeviceId}\tName=${displayName}\tPri=0`);
        } catch (cmdErr) {
          console.warn('Non-blocking: Failed to enqueue ADMS user sync command for support staff:', cmdErr);
        }
      }

      revalidatePath('/dashboard/people');
      revalidatePath('/dashboard/attendance');
      revalidatePath('/dashboard');

      return {
        success: true,
        data: newPerson,
        teacherPin: null
      };
    }

    // -------------------------------------------------------------
    // Branch 2 & 3: Student & Teacher Registration
    // -------------------------------------------------------------
    let params: Record<string, any> = {
      p_role: role,
      p_full_name: fullName.trim(),
      p_device_user_id: cleanDeviceId
    };

    let generatedTeacherPin: string | null = null;
    let studentClassId: string | null = null;

    if (role === 'student') {
      const classId = formData.get('classId') as string;
      if (!classId) {
        return { error: 'Please select a class for the student.' };
      }
      studentClassId = classId;
      params.p_class_id = classId;

      const guardianName = formData.get('guardianName') as string;
      const guardianPhone = formData.get('guardianPhone') as string;
      const guardianRelationship = formData.get('guardianRelationship') as string || 'guardian';

      if (guardianName && guardianName.trim()) {
        params.p_guardian_full_name = guardianName.trim();
      }
      if (guardianPhone && guardianPhone.trim()) {
        params.p_guardian_phone = guardianPhone.trim();
      }
      params.p_guardian_relationship = guardianRelationship.trim();

    } else if (role === 'teacher') {
      const phone = formData.get('phone') as string;
      const classIdsJson = formData.get('classIdsJson') as string;
      let classIds: string[] = [];
      if (classIdsJson) {
        try {
          classIds = JSON.parse(classIdsJson);
        } catch (e) {
          console.error('Failed to parse classIds:', e);
        }
      }

      if (phone && phone.trim()) {
        params.p_phone = phone.trim();
      } else {
        params.p_phone = null;
      }

      // Auto-generate a globally unique Teacher Attendance Passcode / PIN (alphanumeric, e.g. T7K9M2)
      const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      const { data: existingStaff } = await adminClient
        .from('staff_users')
        .select('pin_hash')
        .not('pin_hash', 'is', null);

      let isUnique = false;
      let attempts = 0;
      while (!isUnique && attempts < 50) {
        attempts++;
        let candidate = 'T';
        for (let i = 0; i < 5; i++) {
          candidate += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        let collision = false;
        if (existingStaff && existingStaff.length > 0) {
          for (const su of existingStaff) {
            if (su.pin_hash && bcrypt.compareSync(candidate, su.pin_hash)) {
              collision = true;
              break;
            }
          }
        }
        if (!collision) {
          generatedTeacherPin = candidate;
          isUnique = true;
        }
      }

      params.p_pin = generatedTeacherPin;
      params.p_class_ids = classIds.length > 0 ? classIds : null;
      params.p_issue_manual_link = true;
    }

    // Try invoking the RPC function school.fn_add_person
    let rpcSuccess = false;
    let rpcData: any = null;
    try {
      const { data, error } = await (supabase as any).rpc('fn_add_person', params);
      if (!error) {
        rpcSuccess = true;
        rpcData = data;
      } else {
        console.warn('fn_add_person RPC returned error, using direct table fallback:', error);
      }
    } catch (rpcErr) {
      console.warn('fn_add_person RPC invocation threw:', rpcErr);
    }

    // Fallback if RPC is not supported or failed
    if (!rpcSuccess) {
      if (role === 'student') {
        const { data: newPerson, error: pInsertErr } = await adminClient
          .from('people')
          .insert({
            school_id: schoolId,
            full_name: fullName.trim(),
            role: 'student',
            class_id: studentClassId,
            device_user_id: cleanDeviceId,
            is_active: true
          })
          .select()
          .single();

        if (pInsertErr) {
          if (pInsertErr.code === '23505') {
            return { error: 'The biometric Enrollment ID is already registered to another person in your school.' };
          }
          return { error: pInsertErr.message || 'Failed to register student.' };
        }

        const guardianName = formData.get('guardianName') as string;
        const guardianPhone = formData.get('guardianPhone') as string;
        let guardianLinked = false;

        if (guardianPhone && guardianPhone.trim()) {
          try {
            const { data: parentRec } = await adminClient
              .from('parents')
              .insert({
                school_id: schoolId,
                full_name: guardianName && guardianName.trim() ? guardianName.trim() : 'Guardian',
                phone: guardianPhone.trim()
              })
              .select('id')
              .single();

            if (parentRec?.id) {
              await adminClient
                .from('student_parents')
                .insert({
                  student_id: newPerson.id,
                  parent_id: parentRec.id,
                  relationship: (formData.get('guardianRelationship') as string) || 'guardian',
                  is_primary: true
                });
              guardianLinked = true;
            }
          } catch (gErr) {
            console.warn('Non-blocking: Failed to link parent in fallback:', gErr);
          }
        }

        rpcData = { ...newPerson, guardian_linked: guardianLinked };
      } else if (role === 'teacher') {
        const phone = (formData.get('phone') as string)?.trim() || null;
        const { data: newPerson, error: pInsertErr } = await adminClient
          .from('people')
          .insert({
            school_id: schoolId,
            full_name: fullName.trim(),
            role: 'teacher',
            phone: phone,
            device_user_id: cleanDeviceId,
            is_active: true
          })
          .select()
          .single();

        if (pInsertErr) {
          if (pInsertErr.code === '23505') {
            return { error: 'The biometric Enrollment ID is already registered to another person in your school.' };
          }
          return { error: pInsertErr.message || 'Failed to register teacher.' };
        }

        if (generatedTeacherPin) {
          const salt = bcrypt.genSaltSync(6);
          const pinHash = bcrypt.hashSync(generatedTeacherPin, salt);
          try {
            await adminClient
              .from('staff_users')
              .insert({
                person_id: newPerson.id,
                pin_hash: pinHash,
                role: 'teacher'
              });
          } catch (stErr) {
            console.warn('Non-blocking: staff_users insert in teacher fallback:', stErr);
          }
        }

        rpcData = newPerson;
      }
    }

    // Sync to ZKTeco terminal if device ID provided
    if (cleanDeviceId) {
      try {
        let className = '';
        if (role === 'student' && studentClassId) {
          const { data: cls } = await adminClient
            .from('classes')
            .select('name')
            .eq('id', studentClassId)
            .maybeSingle();
          if (cls?.name) className = cls.name;
        }

        const { formatZKTecoDisplayName } = await import('@/utils/zkteco/formatter');
        const { enqueueDeviceCommand } = await import('@/utils/zkteco/commandQueue');

        const displayName = formatZKTecoDisplayName({
          full_name: fullName.trim(),
          role: role,
          classes: className ? { name: className } : null
        });

        await enqueueDeviceCommand(`DATA UPDATE userinfo PIN=${cleanDeviceId}\tName=${displayName}\tPri=0`);
      } catch (cmdErr) {
        console.warn('Non-blocking: Failed to enqueue ADMS user sync command:', cmdErr);
      }
    }

    revalidatePath('/dashboard/people');
    revalidatePath('/dashboard/attendance');
    revalidatePath('/dashboard');

    return { 
      success: true,
      data: rpcData,
      teacherPin: generatedTeacherPin
    };
  } catch (err: any) {
    console.error('addPersonAction server error:', err);
    return { error: err?.message || 'An unexpected error occurred.' };
  }
}

export async function resetTeacherPinAction(personId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Not authenticated. Please log in.' };
  }

  try {
    // 1. Verify target person is a teacher
    const { data: person, error: pErr } = await supabase
      .from('people')
      .select('id, full_name, role')
      .eq('id', personId)
      .single();

    if (pErr || !person || person.role !== 'teacher') {
      return { error: 'Teacher record not found.' };
    }

    // 2. Auto-generate a unique 6-character PIN (e.g. T7K9M2)
    const adminClient = createAdminClient();
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

    const { data: existingStaff } = await adminClient
      .from('staff_users')
      .select('pin_hash')
      .not('pin_hash', 'is', null);

    let isUnique = false;
    let attempts = 0;
    let newPin = '';

    while (!isUnique && attempts < 50) {
      attempts++;
      let candidate = 'T';
      for (let i = 0; i < 5; i++) {
        candidate += chars.charAt(Math.floor(Math.random() * chars.length));
      }

      let collision = false;
      if (existingStaff && existingStaff.length > 0) {
        for (const su of existingStaff) {
          if (su.pin_hash && bcrypt.compareSync(candidate, su.pin_hash)) {
            collision = true;
            break;
          }
        }
      }
      if (!collision) {
        newPin = candidate;
        isUnique = true;
      }
    }

    if (!newPin) {
      return { error: 'Failed to generate a unique PIN. Please try again.' };
    }

    // 3. Hash the new PIN using bcrypt with salt rounds = 6
    const salt = bcrypt.genSaltSync(6);
    const pinHash = bcrypt.hashSync(newPin, salt);

    // 4. Update staff_users table for this teacher
    const { error: updateErr } = await adminClient
      .from('staff_users')
      .update({
        pin_hash: pinHash,
        pin_failed_attempts: 0,
        pin_locked_until: null,
      })
      .eq('person_id', personId);

    if (updateErr) {
      console.error('Error resetting teacher PIN:', updateErr);
      return { error: 'Failed to update passcode in database.' };
    }

    revalidatePath('/dashboard/people');
    return {
      success: true,
      newPin,
      teacherName: person.full_name,
    };
  } catch (err: any) {
    console.error('resetTeacherPinAction server error:', err);
    return { error: err?.message || 'An unexpected error occurred.' };
  }
}

export async function updatePersonDeviceUserIdAction(personId: string, deviceUserId: string | null) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Not authenticated. Please log in.' };
  }

  try {
    const adminClient = createAdminClient();
    const cleanUid = deviceUserId && deviceUserId.trim() ? deviceUserId.trim() : null;

    // 1. Fetch person details to verify and get info for device command
    const { data: person, error: pErr } = await adminClient
      .from('people')
      .select('id, full_name, role, school_id, class_id, classes:class_id(name)')
      .eq('id', personId)
      .single();

    if (pErr || !person) {
      return { error: 'Person record not found.' };
    }

    // 2. If UID is being set, ensure it's not already used by another person in the same school
    if (cleanUid) {
      const { data: existingPerson } = await adminClient
        .from('people')
        .select('id, full_name, role')
        .eq('school_id', person.school_id)
        .eq('device_user_id', cleanUid)
        .neq('id', personId)
        .maybeSingle();

      if (existingPerson) {
        return { 
          error: `Biometric UID ${cleanUid} is already assigned to ${existingPerson.full_name} (${existingPerson.role}).` 
        };
      }
    }

    // 3. Update device_user_id in people table
    const { error: updateErr } = await adminClient
      .from('people')
      .update({ device_user_id: cleanUid })
      .eq('id', personId);

    if (updateErr) {
      console.error('Error updating device_user_id:', updateErr);
      return { error: updateErr.message || 'Failed to update biometric UID.' };
    }

    // 4. If cleanUid is assigned, enqueue command to ZKTeco terminal
    if (cleanUid) {
      try {
        const { formatZKTecoDisplayName } = await import('@/utils/zkteco/formatter');
        const { enqueueDeviceCommand } = await import('@/utils/zkteco/commandQueue');

        const displayName = formatZKTecoDisplayName({
          full_name: person.full_name,
          role: person.role,
          classes: (person as any).classes?.name ? { name: (person as any).classes.name } : null
        });

        await enqueueDeviceCommand(`DATA UPDATE userinfo PIN=${cleanUid}\tName=${displayName}\tPri=0`);
      } catch (cmdErr) {
        console.warn('Non-blocking: Failed to enqueue ADMS user sync command:', cmdErr);
      }
    }

    revalidatePath('/dashboard/people');
    revalidatePath('/dashboard/attendance');
    revalidatePath('/dashboard');
    return { success: true };
  } catch (err: any) {
    console.error('updatePersonDeviceUserIdAction error:', err);
    return { error: err?.message || 'An unexpected error occurred.' };
  }
}

