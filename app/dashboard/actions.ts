'use server';

import { requireSchoolAdmin } from '@/lib/auth-guard';

/**
 * SMS delivery belongs to the deployed Supabase Edge Function/database trigger.
 * This legacy action intentionally does not mark queued messages as sent or
 * simulate provider delivery; doing so would hide real delivery failures.
 */
export async function processPendingNotificationsAction() {
  try {
    await requireSchoolAdmin();
    return {
      success: false,
      error: 'SMS delivery is handled by the Supabase Edge Function. Pending notifications were not modified.',
    };
  } catch (err: any) {
    return { error: err?.message || 'Unauthorized' };
  }
}
