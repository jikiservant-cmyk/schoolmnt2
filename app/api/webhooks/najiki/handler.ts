import { NextRequest, NextResponse } from 'next/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import crypto from 'crypto';

export async function handleNajikiWebhook(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const headersList = req.headers;

    // Secret key for verification
    const expectedSecret = 
      process.env.NAJIKI_API_KEY || 
      process.env.SCHOOL_SECRET_KEY || 
      process.env.NAJIKI_SECRET_KEY;

    if (!expectedSecret) {
      console.error('[NaJiki Webhook] Missing webhook secret configuration in environment variables.');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const authHeader = headersList.get('authorization');
    const signatureHeader = headersList.get('x-najiki-signature') || headersList.get('x-signature') || headersList.get('x-webhook-signature');

    if (!authHeader && !signatureHeader) {
      console.warn('[NaJiki Webhook] Missing authentication headers.');
      return NextResponse.json({ error: 'Unauthorized: Missing authentication headers' }, { status: 401 });
    }

    let isAuthorized = false;

    // 1. Verify Authorization Bearer token
    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token === expectedSecret) {
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
        console.warn('[NaJiki Webhook] HMAC signature verification failed:', sigErr);
      }
    }

    if (!isAuthorized) {
      console.warn('[NaJiki Webhook] Unauthorized NaJiki webhook attempt.');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    console.log('[NaJiki Webhook] Received payload:', JSON.stringify(payload));

    const publicAdmin = createPublicAdminClient();
    const eventType = (payload.event || payload.eventType || payload.type || payload.event_type || '').toString().toLowerCase();
    const rawStatus = (payload.status || payload.data?.status || '').toString().toUpperCase();
    const eventData = payload.data || payload;

    // Check if this is a payment success event or status
    const isPaymentSuccess = 
      eventType.includes('payment.success') ||
      eventType.includes('payment_success') ||
      eventType.includes('payment.completed') ||
      eventType.includes('charge.success') ||
      eventType.includes('transaction.success') ||
      eventType === 'success' ||
      rawStatus === 'SUCCESS' ||
      rawStatus === 'COMPLETED' ||
      rawStatus === 'PAID';

    if (isPaymentSuccess) {
      const schoolId = 
        eventData.school_id || 
        eventData.schoolId || 
        eventData.tenant_id ||
        eventData.tenantId ||
        eventData.tenantCode || 
        eventData.tenant_code ||
        eventData.externalEntityId ||
        eventData.external_entity_id ||
        eventData.metadata?.schoolId || 
        eventData.metadata?.school_id ||
        eventData.metadata?.tenantId ||
        eventData.metadata?.tenant_id;

      const amount = Number(
        eventData.amount || 
        eventData.value || 
        eventData.total || 
        eventData.metadata?.amount || 
        0
      );

      const txRef = 
        eventData.transaction_ref || 
        eventData.transactionRef ||
        eventData.transaction_id ||
        eventData.transactionId ||
        eventData.reference || 
        eventData.paymentIntentId || 
        eventData.idempotencyKey ||
        eventData.idempotency_key ||
        eventData.ext_ref ||
        `tx_${Date.now()}`;
      
      if (schoolId && amount > 0) {
        let targetSchoolId = schoolId;
        // If schoolId was passed as a tenant code, resolve to school_id or user id from public.profiles
        try {
          const { data: prof } = await publicAdmin
            .from('profiles')
            .select('id, user_id, school_id, code')
            .eq('code', schoolId)
            .maybeSingle();

          if (prof?.school_id) {
            targetSchoolId = prof.school_id;
          } else if (prof?.id) {
            targetSchoolId = prof.id;
          }
        } catch {
          // ignore
        }

        console.log(`[NaJiki Webhook] Processing wallet credit for school ${targetSchoolId} (raw identifier: ${schoolId}) with amount ${amount} UGX, ref: ${txRef}`);
        
        let credited = false;

        // 1. Try RPC credit_wallet
        try {
          const { data: rpcResult, error: rpcError } = await publicAdmin.rpc("credit_wallet", {
            p_school_id: targetSchoolId,
            p_amount: amount,
            p_tx_ref: txRef,
          });

          if (!rpcError) {
            console.log('[NaJiki Webhook] Successfully credited wallet via RPC:', rpcResult);
            credited = true;
          } else {
            console.warn('[NaJiki Webhook] RPC credit_wallet returned notice:', rpcError.message);
          }
        } catch (rpcEx) {
          console.warn('[NaJiki Webhook] RPC credit_wallet call exception:', rpcEx);
        }

        // 2. Direct database update fallback (wallets + schools settings + transactions)
        try {
          // Find existing wallet by tenant_id or school_id
          let { data: walletData } = await publicAdmin
            .from('wallets')
            .select('id, balance')
            .or(`tenant_id.eq.${targetSchoolId},school_id.eq.${targetSchoolId}`)
            .maybeSingle();

          let walletId = walletData?.id;
          const currentBal = Number(walletData?.balance || 0);
          const newBal = currentBal + amount;

          if (!walletData) {
            const genId = crypto.randomUUID();
            const { data: newWallet } = await publicAdmin
              .from('wallets')
              .insert({ 
                id: genId,
                school_id: targetSchoolId, 
                tenant_id: targetSchoolId,
                balance: amount,
                currency: 'UGX',
                sms_rate: 50
              })
              .select('id')
              .maybeSingle();
            walletId = newWallet?.id || genId;
          } else {
            await publicAdmin
              .from('wallets')
              .update({ balance: newBal })
              .eq('id', walletId);
          }

          // 3. Keep schools.settings.balance in sync
          try {
            const { data: schoolRecord } = await publicAdmin
              .from('schools')
              .select('id, settings')
              .eq('id', targetSchoolId)
              .maybeSingle();

            if (schoolRecord) {
              const currentSettings = schoolRecord.settings || {};
              await publicAdmin
                .from('schools')
                .update({
                  settings: {
                    ...currentSettings,
                    balance: (Number(currentSettings.balance) || 0) + amount
                  }
                })
                .eq('id', targetSchoolId);
            }
          } catch (schErr) {
            console.warn('[NaJiki Webhook] Notice updating schools.settings:', schErr);
          }

          // 4. Record transaction
          if (walletId) {
            try {
              await publicAdmin.from('transactions').insert({
                wallet_id: walletId,
                amount: amount,
                type: 'credit',
                reference: txRef,
                status: 'completed',
                description: `NaJiki Mobile Money Top-up (+${amount.toLocaleString()} UGX)`
              });
            } catch (tErr) {
              console.warn('[NaJiki Webhook] Notice inserting transactions row:', tErr);
            }
          }

          credited = true;
          console.log(`[NaJiki Webhook] Successfully credited wallet. New balance: ${newBal} UGX`);
        } catch (dbErr) {
          console.error('[NaJiki Webhook] Database fallback error:', dbErr);
          if (!credited) {
            return NextResponse.json({ error: 'Failed to credit wallet' }, { status: 500 });
          }
        }

        return NextResponse.json({ 
          success: true, 
          message: `Successfully credited ${amount} UGX to school ${schoolId}`,
          reference: txRef 
        }, { status: 200 });

      } else {
        console.warn('[NaJiki Webhook] Missing required fields for payment.success', { schoolId, amount, txRef, eventData });
        return NextResponse.json({ error: 'Missing required payment fields (schoolId, amount)' }, { status: 400 });
      }
    } 
    
    // Handle SMS delivery reports
    else if (
      eventType === "message.status" || 
      eventType === "sms_delivery_update" ||
      eventType.includes("sms") ||
      eventType.includes("delivery")
    ) {
      const smsId = eventData.messageId || eventData.smsId || eventData.id || eventData.provider_ref;
      const statusStr = (eventData.status || '').toString().toUpperCase();
      const status = (statusStr === 'DELIVERED' || statusStr === 'SENT' || statusStr === 'SUCCESS') ? 'sent' : 'failed';
      
      if (smsId) {
        // Try updating by provider_ref first
        const { data: updatedByRef } = await publicAdmin
          .from('notifications')
          .update({ status: status })
          .eq('provider_ref', smsId)
          .select();
          
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
    console.error('[NaJiki Webhook] Error handling webhook:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
