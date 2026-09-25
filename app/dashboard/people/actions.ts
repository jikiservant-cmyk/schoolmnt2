'use server';

import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { requireSchoolAdmin } from '@/lib/auth-guard';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';
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
    const { supabase, schoolId } = await requireSchoolAdmin();
    const adminClient = createAdminClient();
    const warnings: string[] = [];
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
          const { enqueuePersonEnrollmentForSchool } = await import('@/utils/zkteco/commandQueue');
          const enrollment = await enqueuePersonEnrollmentForSchool(
            {
              pin: cleanDeviceId,
              fullName: fullName.trim(),
              role: 'support_staff',
              className: null
            },
            schoolId
          );
          if (enrollment.totalDevices === 0) {
            warnings.push('No active device was available to receive the biometric enrollment.');
          } else if (enrollment.queuedCount < enrollment.totalDevices) {
            warnings.push(`Enrollment was queued to only ${enrollment.queuedCount} of ${enrollment.totalDevices} active devices.`);
          }
        } catch (cmdErr) {
          console.warn('Support staff registered, but device enrollment queueing failed:', cmdErr);
          warnings.push('The profile was saved, but device enrollment could not be queued.');
        }
      }

      revalidatePath('/dashboard/people');
      revalidatePath('/dashboard/attendance');
      revalidatePath('/dashboard');

      return {
        success: true,
        data: newPerson,
        teacherPin: null,
        warnings,
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
      const { data: existingStaff, error: existingStaffError } = await adminClient
        .from('staff_users')
        .select('pin_hash')
        .not('pin_hash', 'is', null);
      if (existingStaffError) {
        console.error('Could not verify existing teacher attendance PINs:', existingStaffError);
        return { error: 'Could not safely generate a unique teacher attendance PIN. Please retry.' };
      }

      let isUnique = false;
      let attempts = 0;
      while (!isUnique && attempts < 50) {
        attempts++;
        let candidate = 'T';
        for (let i = 0; i < 5; i++) {
          candidate += chars.charAt(crypto.randomInt(chars.length));
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

        let guardianLinkWarning = false;
        if (guardianPhone && guardianPhone.trim()) {
          const { data: parentRec, error: parentError } = await adminClient
            .from('parents')
            .insert({
              school_id: schoolId,
              full_name: guardianName && guardianName.trim() ? guardianName.trim() : 'Guardian',
              phone: guardianPhone.trim()
            })
            .select('id')
            .single();

          if (parentError || !parentRec?.id) {
            console.error('Failed to create guardian record in fallback:', parentError);
            guardianLinkWarning = true;
          } else {
            const { error: linkError } = await adminClient
              .from('student_parents')
              .insert({
                student_id: newPerson.id,
                parent_id: parentRec.id,
                relationship: (formData.get('guardianRelationship') as string) || 'guardian',
                is_primary_contact: true
              });

            if (linkError) {
              console.error('Failed to link guardian in fallback:', linkError);
              guardianLinkWarning = true;
            } else {
              guardianLinked = true;
            }
          }
        }

        rpcData = {
          ...newPerson,
          guardian_linked: guardianLinked,
          guardian_link_warning: guardianLinkWarning,
        };
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
          const salt = bcrypt.genSaltSync(10);
          const pinHash = bcrypt.hashSync(generatedTeacherPin, salt);
          const { data: staffRow, error: staffInsertError } = await adminClient
            .from('staff_users')
            .insert({
              person_id: newPerson.id,
              pin_hash: pinHash,
              role: 'teacher'
            })
            .select('id')
            .maybeSingle();
          if (staffInsertError || !staffRow?.id) {
            console.error('Teacher profile saved but attendance PIN persistence failed:', staffInsertError);
            warnings.push('The teacher profile was saved, but the attendance PIN could not be stored. Regenerate it before use.');
            generatedTeacherPin = null;
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

        const { enqueuePersonEnrollmentForSchool } = await import('@/utils/zkteco/commandQueue');
        const enrollment = await enqueuePersonEnrollmentForSchool(
          {
            pin: cleanDeviceId,
            fullName: fullName.trim(),
            role: role,
            className: className || null
          },
          schoolId
        );
        if (enrollment.totalDevices === 0) {
          warnings.push('The profile was saved, but no active device was available to receive the biometric enrollment.');
        } else if (enrollment.queuedCount < enrollment.totalDevices) {
          warnings.push(`The profile was saved, but enrollment was queued to only ${enrollment.queuedCount} of ${enrollment.totalDevices} active devices.`);
        }
      } catch (cmdErr) {
        console.warn('Profile saved, but device enrollment queueing failed:', cmdErr);
        warnings.push('The profile was saved, but device enrollment could not be queued.');
      }
    }

    revalidatePath('/dashboard/people');
    revalidatePath('/dashboard/attendance');
    revalidatePath('/dashboard');

    return {
      success: true,
      data: rpcData,
      teacherPin: generatedTeacherPin,
      warnings,
    };
  } catch (err: any) {
    console.error('addPersonAction server error:', err);
    return { error: err?.message || 'An unexpected error occurred.' };
  }
}

export async function resetTeacherPinAction(personId: string) {
  try {
    const { schoolId } = await requireSchoolAdmin();
    // 1. Verify target person is a teacher and belongs to the caller's school
    const adminClient = createAdminClient();
    const { data: person, error: pErr } = await adminClient
      .from('people')
      .select('id, full_name, role, school_id')
      .eq('id', personId)
      .eq('school_id', schoolId)
      .single();

    if (pErr || !person || person.role !== 'teacher') {
      return { error: 'Teacher record not found or access denied.' };
    }

    // 2. Auto-generate a unique 6-character PIN (e.g. T7K9M2)
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

    const { data: existingStaff, error: existingStaffError } = await adminClient
      .from('staff_users')
      .select('pin_hash')
      .not('pin_hash', 'is', null);
    if (existingStaffError) {
      console.error('Could not verify existing teacher attendance PINs:', existingStaffError);
      return { error: 'Could not safely generate a unique teacher attendance PIN. Please retry.' };
    }

    let isUnique = false;
    let attempts = 0;
    let newPin = '';

    while (!isUnique && attempts < 50) {
      attempts++;
      let candidate = 'T';
      for (let i = 0; i < 5; i++) {
        candidate += chars.charAt(crypto.randomInt(chars.length));
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

    // 3. Hash the new PIN using a work factor suitable for production.
    const salt = bcrypt.genSaltSync(10);
    const pinHash = bcrypt.hashSync(newPin, salt);

    // 4. Update or create the staff_users row and verify that a row was persisted.
    const pinUpdate = await adminClient
      .from('staff_users')
      .update({
        pin_hash: pinHash,
        failed_attempts: 0,
        locked_until: null,
      })
      .eq('person_id', personId)
      .select('id')
      .maybeSingle();

    if (pinUpdate.error) {
      console.error('Error resetting teacher PIN:', pinUpdate.error);
      return { error: 'Failed to update passcode in database.' };
    }

    if (!pinUpdate.data?.id) {
      const { data: insertedStaff, error: staffInsertError } = await adminClient
        .from('staff_users')
        .insert({ person_id: personId, pin_hash: pinHash, role: 'teacher', failed_attempts: 0, locked_until: null })
        .select('id')
        .maybeSingle();
      if (staffInsertError || !insertedStaff?.id) {
        console.error('Error creating teacher passcode row:', staffInsertError);
        return { error: 'Failed to persist the teacher passcode.' };
      }
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

export async function searchPeopleAction(params: {
  searchTerm?: string;
  roleFilter?: string;
  statusFilter?: string;
  page?: number;
  limit?: number;
}) {
  try {
    const { supabase, schoolId } = await requireSchoolAdmin();
    
    let query = supabase
      .from('people')
    .select('id, full_name, role, class_id, device_user_id, phone, is_active', { count: 'exact' })
    .eq('school_id', schoolId);

  if (params.roleFilter && params.roleFilter !== 'all') {
    query = query.eq('role', params.roleFilter);
  }
  
  if (params.statusFilter === 'active') {
    query = query.eq('is_active', true);
  } else if (params.statusFilter === 'inactive') {
    query = query.eq('is_active', false);
  }

  if (params.searchTerm && params.searchTerm.trim() !== '') {
    // Remove PostgREST logic/pattern metacharacters before composing the OR
    // expression. Search is still tenant-scoped by the school_id predicate.
    const st = params.searchTerm.trim().slice(0, 100).replace(/[\\,().%_*]/g, ' ').trim();
    if (st) {
      query = query.or(`full_name.ilike.%${st}%,phone.ilike.%${st}%,device_user_id.ilike.%${st}%`);
    }
  }

  // order by full name
  query = query.order('full_name', { ascending: true });

  const page = Number.isSafeInteger(params.page) ? Math.max(1, Math.min(params.page!, 100_000)) : 1;
  const requestedLimit = Number.isSafeInteger(params.limit) ? params.limit! : 50;
  const limit = Math.max(1, Math.min(requestedLimit, 100));
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  query = query.range(from, to);

  const { data, count, error } = await query;
  
  if (error) {
    console.error('searchPeopleAction error:', error);
    return { error: error.message, data: [], count: 0 };
  }

    return { success: true, data: data || [], count: count || 0 };
  } catch (err: any) {
    console.error('searchPeopleAction error:', err);
    return { error: err.message || 'Unauthorized', data: [], count: 0 };
  }
}

export async function updatePersonDeviceUserIdAction(personId: string, deviceUserId: string | null) {
  try {
    const { schoolId } = await requireSchoolAdmin();
    const adminClient = createAdminClient();
    const cleanUid = deviceUserId && deviceUserId.trim() ? deviceUserId.trim() : null;

    // 1. Fetch person details to verify and get info for device command
    const { data: person, error: pErr } = await adminClient
      .from('people')
      .select('id, full_name, role, school_id, class_id, classes:class_id(name)')
      .eq('id', personId)
      .eq('school_id', schoolId)
      .single();

    if (pErr || !person) {
      return { error: 'Person record not found or access denied.' };
    }

    // 2. If UID is being set, ensure it's not already used by another person in the same school
    if (cleanUid) {
      const { data: existingPerson, error: existingPersonError } = await adminClient
        .from('people')
        .select('id, full_name, role')
        .eq('school_id', person.school_id)
        .eq('device_user_id', cleanUid)
        .neq('id', personId)
        .maybeSingle();

      if (existingPersonError) {
        return { error: 'Could not verify whether this biometric UID is already in use.' };
      }
      if (existingPerson) {
        return {
          error: `Biometric UID ${cleanUid} is already assigned to ${existingPerson.full_name} (${existingPerson.role}).`
        };
      }
    }

    const optionalCredentialSchemaCodes = new Set(['PGRST204', 'PGRST205', '42P01', '42703']);
    let credentialSchemaAvailable = true;
    if (cleanUid) {
      // Backslash-escape LIKE wildcards so a user-entered UID is treated as an
      // exact, case-insensitive identifier rather than a search pattern.
      const escapedUid = cleanUid.replace(/[\\%_]/g, '\\$&');
      const { data: existingCredential, error: credentialLookupError } = await adminClient
        .from('person_credentials')
        .select('person_id')
        .eq('school_id', schoolId)
        .eq('credential_type', 'pin')
        .ilike('identifier_value', escapedUid)
        .neq('person_id', personId)
        .maybeSingle();

      if (credentialLookupError && optionalCredentialSchemaCodes.has(credentialLookupError.code || '')) {
        credentialSchemaAvailable = false;
      } else if (credentialLookupError) {
        console.error('Could not verify the secondary biometric credential:', credentialLookupError);
        return { error: 'Could not safely verify this biometric UID. No changes were saved.' };
      } else if (existingCredential) {
        return { error: 'This biometric UID is already assigned to another person in your school.' };
      }
    }

    if (credentialSchemaAvailable) {
      const { error: deactivateCredentialError } = await adminClient
        .from('person_credentials')
        .update({ is_active: false })
        .eq('school_id', schoolId)
        .eq('person_id', personId)
        .eq('credential_type', 'pin');

      if (deactivateCredentialError && optionalCredentialSchemaCodes.has(deactivateCredentialError.code || '')) {
        credentialSchemaAvailable = false;
      } else if (deactivateCredentialError) {
        console.error('Could not deactivate prior biometric credentials:', deactivateCredentialError);
        return { error: 'Could not safely update stored biometric credentials. No UID changes were saved.' };
      }
    }

    // 3. Update device_user_id in people table
    const { error: updateErr } = await adminClient
      .from('people')
      .update({ device_user_id: cleanUid })
      .eq('id', personId)
      .eq('school_id', schoolId);

    if (updateErr) {
      console.error('Error updating device_user_id:', updateErr);
      return { error: updateErr.message || 'Failed to update biometric UID.' };
    }

    // 4. Sync into school.person_credentials table if cleanUid is present.
    // The legacy people.device_user_id remains the primary mapping, so an
    // optional credential-schema/upsert failure does not undo the saved UID.
    const warnings: string[] = [];
    if (cleanUid && credentialSchemaAvailable) {
      const { error: credentialUpsertError } = await adminClient
        .from('person_credentials')
        .upsert(
          {
            school_id: schoolId,
            person_id: personId,
            credential_type: 'pin',
            identifier_value: cleanUid,
            is_active: true
          },
          { onConflict: 'school_id,credential_type,identifier_value' }
        );

      if (credentialUpsertError) {
        console.warn('Biometric UID saved, but secondary credential sync failed:', credentialUpsertError);
        warnings.push('The UID was saved, but the secondary biometric credential record could not be synchronized.');
      }
    }

    if (cleanUid) {
      try {
        const { enqueuePersonEnrollmentForSchool } = await import('@/utils/zkteco/commandQueue');
        const enrollment = await enqueuePersonEnrollmentForSchool(
          {
            pin: cleanUid,
            fullName: person.full_name,
            role: person.role,
            className: (person as any).classes?.name || null
          },
          schoolId
        );

        if (enrollment.totalDevices === 0) {
          warnings.push('The UID was saved, but no active device was available to receive the enrollment.');
        } else if (enrollment.queuedCount < enrollment.totalDevices) {
          warnings.push(`The UID was saved, but enrollment was queued to only ${enrollment.queuedCount} of ${enrollment.totalDevices} active devices.`);
        }
      } catch (cmdErr) {
        console.warn('Biometric UID saved, but enrollment queueing failed:', cmdErr);
        warnings.push('The UID was saved, but device enrollment could not be queued.');
      }
    }

    revalidatePath('/dashboard/people');
    revalidatePath('/dashboard/attendance');
    revalidatePath('/dashboard');
    return warnings.length > 0 ? { success: true, warnings } : { success: true };
  } catch (err: any) {
    console.error('updatePersonDeviceUserIdAction error:', err);
    return { error: err?.message || 'An unexpected error occurred.' };
  }
}

