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

    if (payload.event === "payment.success" || payload.eventType === "payment.success") {
      const schoolId = payload.school_id || payload.metadata?.schoolId || payload.tenantCode || payload.externalEntityId;
      const amount = payload.amount || payload.metadata?.amount;
      const txRef = payload.transaction_ref || payload.reference || payload.paymentIntentId || payload.idempotencyKey;
      
      if (schoolId && amount && txRef) {
        await publicAdmin.rpc("credit_wallet", {
          p_school_id: schoolId,
          p_amount: amount,
          p_tx_ref: txRef,
        });
      }
    } else if (payload.event === "message.status" || payload.eventType === "SMS_DELIVERY_UPDATE") {
      // Handle both the simpler payload structure from user and existing one
      const smsId = payload.messageId || payload.smsId || payload.id;
      const rawStatus = (payload.status || '').toString().toUpperCase();
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
