'use server';

import { createClient } from '@/utils/supabase/server';
import { revalidatePath } from 'next/cache';

export async function processPendingNotificationsAction() {
  const supabase = await createClient();

  try {
    // 1. Fetch pending notifications
    const { data: pending, error } = await supabase
      .from('notifications')
      .select('*')
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

      const { error: updateErr } = await supabase
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
        .eq('id', item.id);

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
