'use server';

import { createClient } from '@/utils/supabase/server';
import { revalidatePath } from 'next/cache';

export async function addClassAction(formData: FormData) {
  const supabase = await createClient();
  const name = formData.get('name') as string;
  const teacherId = formData.get('teacherId') as string || null;

  if (!name) {
    return { error: 'Class name is required.' };
  }

  const trimmedName = name.trim();
  const firstChar = trimmedName.charAt(0);
  if (firstChar === 'p' || firstChar === 's') {
    return { error: 'Class names starting with P or S must have their first letter capitalized (e.g., P3 or S4).' };
  }

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return { error: 'Not authenticated. Please log in.' };
    }

    // Resolve the active school ID using the security definer RPC function
    const { data: schoolId, error: schoolErr } = await supabase.rpc('auth_school_id');
    if (schoolErr || !schoolId) {
      console.error('Failed to resolve school ID via auth_school_id:', schoolErr);
      return { error: 'Your school context could not be resolved. Please contact support.' };
    }

    // Find the current active academic year for this school
    let { data: activeYear } = await supabase
      .from('academic_years')
      .select('id')
      .eq('school_id', schoolId)
      .eq('is_current', true)
      .maybeSingle();

    let yearId = activeYear?.id;

    if (!yearId) {
      // Seamlessly bootstrap a current term if none exists
      const { data: newYear, error: yearErr } = await supabase
        .from('academic_years')
        .insert({
          school_id: schoolId,
          name: 'Academic Year 2026',
          is_current: true
        })
        .select('id')
        .single();

      if (yearErr) {
        return { error: `Failed to initialize academic year: ${yearErr.message}` };
      }
      yearId = newYear.id;
    }

    // Insert class record
    const { error: insertErr } = await supabase
      .from('classes')
      .insert({
        school_id: schoolId,
        academic_year_id: yearId,
        name: name.trim(),
        teacher_id: teacherId || null
      });

    if (insertErr) {
      if (insertErr.code === '23505') {
        return { error: `A class named "${name}" already exists in the current academic term.` };
      }
      return { error: insertErr.message };
    }

    revalidatePath('/dashboard/classes');
    return { success: true };
  } catch (err: any) {
    return { error: err?.message || 'An unexpected error occurred.' };
  }
}
