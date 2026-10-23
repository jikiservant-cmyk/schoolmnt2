'use server';

import { revalidatePath } from 'next/cache';
import { requireSchoolAdmin } from '@/lib/auth-guard';
import { createAdminClient } from '@/utils/supabase/admin';
import {
  DEFAULT_SCHOOL_POLICY_SETTINGS,
  getSchoolSettings,
  persistSchoolSettings,
  validateSchoolSettingsInput,
  type ResolvedSchoolConfiguration,
} from '@/lib/school-settings';

function revalidateAllSchoolSurfaces() {
  revalidatePath('/dashboard');
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/attendance');
  revalidatePath('/dashboard/devices');
  revalidatePath('/dashboard/classes');
  revalidatePath('/dashboard/people');
}

export async function getSchoolSettingsAction(): Promise<
  { success: true; settings: ResolvedSchoolConfiguration } | { error: string }
> {
  try {
    const { schoolId } = await requireSchoolAdmin();
    const adminClient = createAdminClient();
    const settings = await getSchoolSettings(adminClient, schoolId);
    return { success: true, settings };
  } catch (err: any) {
    return { error: err?.message || 'Unauthorized' };
  }
}

export async function saveSchoolSettingsAction(
  rawInput: Record<string, unknown>
): Promise<
  | { success: true; settings: ResolvedSchoolConfiguration; message: string }
  | { error: string }
> {
  try {
    // SECURITY: Always authenticate & bind strictly to caller's own schoolId BEFORE inspecting payload.
    const { schoolId, user } = await requireSchoolAdmin();

    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      return { error: 'Invalid settings payload.' };
    }

    // Validate BEFORE stripping keys so any attempt to pass financial/pricing/wallet
    // parameters (`smsPrice`, `smsCost`, `balance`, `wallet`, `defaultTopUpAmount`, etc.)
    // is hard-rejected immediately. `schoolId` / `school_id` are ignored in favor of `requireSchoolAdmin().schoolId`.
    const validated = validateSchoolSettingsInput(rawInput);
    if (!validated.ok) {
      return { error: validated.error };
    }

    const adminClient = createAdminClient();
    const saveRes = await persistSchoolSettings(adminClient, schoolId, validated.policy, {
      schoolName: validated.schoolName,
      updatedBy: user?.id || null,
    });

    if (!saveRes.ok) {
      return { error: saveRes.error };
    }

    const updated = await getSchoolSettings(adminClient, schoolId);
    revalidateAllSchoolSurfaces();

    return {
      success: true,
      settings: updated,
      message: 'School settings saved and active immediately across all terminals and registers.',
    };
  } catch (err: any) {
    return { error: err?.message || 'Failed to save school settings.' };
  }
}

export async function resetSchoolSettingsAction(): Promise<
  | { success: true; settings: ResolvedSchoolConfiguration; message: string }
  | { error: string }
> {
  try {
    const { schoolId, user } = await requireSchoolAdmin();
    const adminClient = createAdminClient();

    const saveRes = await persistSchoolSettings(
      adminClient,
      schoolId,
      { ...DEFAULT_SCHOOL_POLICY_SETTINGS },
      { updatedBy: user?.id || null }
    );

    if (!saveRes.ok) {
      return { error: saveRes.error };
    }

    const updated = await getSchoolSettings(adminClient, schoolId);
    revalidateAllSchoolSurfaces();

    return {
      success: true,
      settings: updated,
      message: 'All operational policies restored to standard defaults.',
    };
  } catch (err: any) {
    return { error: err?.message || 'Failed to reset school settings.' };
  }
}
