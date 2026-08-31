import { NextRequest, NextResponse } from 'next/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import crypto from 'crypto';

export async function handleNajikiWebhook(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const headersList = req.headers;

    // Secret key for verification (matches user spec: school_secret_key_123 or NAJIKI_API_KEY)
    const expectedSecret = 
      process.env.NAJIKI_API_KEY || 
      process.env.SCHOOL_SECRET_KEY || 
      process.env.NAJIKI_SECRET_KEY || 
      'school_secret_key_123';

    const authHeader = headersList.get('authorization');
    const signatureHeader = headersList.get('x-najiki-signature');

    let isAuthorized = false;

    // 1. Verify Authorization Bearer token
    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (
        token === expectedSecret ||
        token === 'school_secret_key_123' ||
        token === (process.env.NAJIKI_API_KEY || 'test_key')
      ) {
        isAuthorized = true;
      }
    }

    // 2. Verify X-Najiki-Signature header (HMAC-SHA256)
    if (!isAuthorized && signatureHeader) {
      try {
        const hmac = crypto.createHmac('sha256', expectedSecret);
        const digest = hmac.update(rawBody).digest('hex');
        if (crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(digest))) {
          isAuthorized = true;
        }
      } catch (sigErr) {
        console.warn('HMAC signature verification failed:', sigErr);
      }
    }

    // Default to true if no headers provided during development / testing, otherwise fail if invalid header sent
    if (authHeader || signatureHeader) {
      if (!isAuthorized) {
        console.warn('Unauthorized NaJiki webhook attempt.');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const publicAdmin = createPublicAdminClient();
    const eventType = payload.event || payload.eventType;
    const eventData = payload.data || payload; // fallback to root payload if data object is not present

    if (eventType === "payment.success") {
      const schoolId = eventData.school_id || eventData.metadata?.schoolId || eventData.tenantCode || eventData.externalEntityId;
      const amount = eventData.amount || eventData.metadata?.amount;
      const txRef = eventData.transaction_ref || eventData.reference || eventData.paymentIntentId || eventData.idempotencyKey;
      
      if (schoolId && amount && txRef) {
        console.log(`[NaJiki Webhook] Crediting wallet for school ${schoolId} with amount ${amount}, ref: ${txRef}`);
        const { data, error } = await publicAdmin.rpc("credit_wallet", {
          p_school_id: schoolId,
          p_amount: amount,
          p_tx_ref: txRef,
        });
        
        if (error) {
          console.error('[NaJiki Webhook] Error calling credit_wallet:', error);
          
          // Fallback: If credit_wallet RPC doesn't exist, try a direct insert/update
          if (error.message.includes('function "credit_wallet" does not exist') || error.code === '42883') {
            console.log('[NaJiki Webhook] Attempting manual wallet credit fallback...');
            
            // 1. Get or create wallet for school
            const { data: walletData, error: walletErr } = await publicAdmin
              .from('wallets')
              .select('id, balance')
              .eq('school_id', schoolId)
              .maybeSingle();
              
            if (walletErr) {
              console.error('[NaJiki Webhook] Error fetching wallet:', walletErr);
            } else {
              let walletId = walletData?.id;
              
              if (!walletData) {
                const { data: newWallet } = await publicAdmin
                  .from('wallets')
                  .insert({ school_id: schoolId, balance: amount })
                  .select('id')
                  .single();
                walletId = newWallet?.id;
              } else {
                await publicAdmin
                  .from('wallets')
                  .update({ balance: (walletData.balance || 0) + Number(amount) })
                  .eq('id', walletId);
              }
              
              // 2. Record transaction
              if (walletId) {
                await publicAdmin.from('transactions').insert({
                  wallet_id: walletId,
                  amount: amount,
                  type: 'credit',
                  reference: txRef,
                  status: 'completed'
                });
                console.log(`[NaJiki Webhook] Successfully credited wallet manually.`);
              }
            }
          }
          // Return an error so the webhook sender knows it failed
          return NextResponse.json({ error: 'Failed to credit wallet', details: error.message }, { status: 500 });
        } else {
          console.log('[NaJiki Webhook] Successfully credited wallet via RPC:', data);
        }
      } else {
        console.warn('[NaJiki Webhook] Missing required fields for payment.success', { schoolId, amount, txRef, eventData });
        return NextResponse.json({ error: 'Missing required payment fields' }, { status: 400 });
      }
    } else if (eventType === "message.status" || eventType === "SMS_DELIVERY_UPDATE") {
      // Handle both the simpler payload structure from user and existing one
      const smsId = eventData.messageId || eventData.smsId || eventData.id;
      const rawStatus = (eventData.status || '').toString().toUpperCase();
      const status = (rawStatus === 'DELIVERED' || rawStatus === 'SENT' || rawStatus === 'SUCCESS') ? 'sent' : 'failed';
      
      if (smsId) {
        // Try updating by provider_ref first (the new standard)
        const { data: updatedByRef } = await publicAdmin
          .from('notifications')
          .update({ status: status })
          .eq('provider_ref', smsId)
          .select();
          
        // If not found by provider_ref, try by ID (legacy fallback)
        if (!updatedByRef || updatedByRef.length === 0) {
          await publicAdmin
            .from('notifications')
            .update({ status: status })
            .eq('id', smsId);
        }
      }
    }

    return NextResponse.json({ received: true }, { status: 200 });

  } catch (err: any) {
    console.error('Error handling NaJiki webhook:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
