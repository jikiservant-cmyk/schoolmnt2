'use server';

import { createClient } from '@/utils/supabase/server';
import { requireSchoolAdmin } from '@/lib/auth-guard';
import { createAdminClient } from '@/utils/supabase/admin';
import { revalidatePath } from 'next/cache';

/**
 * DEMO ONLY: marks queued SMS as "sent" with made-up provider data WITHOUT
 * sending anything. With real parents and paid SMS this would hide messages
 * that were never delivered, so it is disabled unless SMS_SIMULATION_MODE=true.
 */
export async function processPendingNotificationsAction() {
  if (process.env.SMS_SIMULATION_MODE !== 'true') {
    return { error: 'SMS simulation is disabled. Queued messages are delivered by the SMS gateway.' };
  }
  try {
    const { supabase, schoolId } = await requireSchoolAdmin();
    // 1. Fetch pending notifications for this school only
    const { data: pending, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('school_id', schoolId)
      .eq('status', 'pending');

    if (error) {
      console.error('Error fetching pending notifications:', error);
      return { error: error.message };
    }

    if (!pending || pending.length === 0) {
      return { success: true, processedCount: 0, message: 'No pending notifications found in the queue.' };
    }

    // 2. Process each pending notification
    let successCount = 0;
    for (const item of pending) {
      // Simulate real latency of outbound SMS providers (e.g. Africa's Talking or Twilio)
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Clients can no longer write the SMS queue (migration 06): use the
      // server client, still scoped to this admin's school.
      const { error: updateErr } = await createAdminClient()
        .from('notifications')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          provider_response: JSON.stringify({
            status: 'Delivered',
            message_id: `msg_${Math.random().toString(36).substring(2, 15)}`,
            provider: 'AfricaTalkingSMS_Gateway',
            network: 'MTN_Uganda',
            cost: '22 UGX'
          })
        })
        .eq('id', item.id)
        .eq('school_id', schoolId);

      if (updateErr) {
        console.error(`Failed to update notification ${item.id}:`, updateErr);
      } else {
        successCount++;
      }
    }

    revalidatePath('/dashboard');
    return { 
      success: true, 
      processedCount: successCount, 
      message: `Successfully simulated outbound SMS carrier delivery for ${successCount} pending notifications.` 
    };
  } catch (err: any) {
    console.error('Exception processing notifications:', err);
    return { error: err?.message || 'An unexpected exception occurred.' };
  }
}
