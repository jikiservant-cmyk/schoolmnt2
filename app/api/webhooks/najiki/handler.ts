import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient, createPublicAdminClient } from '@/utils/supabase/admin';
import crypto from 'crypto';
import { readRequestTextLimited, RequestBodyTooLargeError } from '@/lib/http/read-limited-body';

const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export async function handleNajikiWebhook(req: NextRequest) {
  try {
    let rawBody: string;
    try {
      rawBody = await readRequestTextLimited(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: 'Webhook payload exceeds the 512 KiB limit.' }, { status: 413 });
      }
      console.error('[NaJiki Webhook] Failed to read request body:', error);
      return NextResponse.json({ error: 'Could not read webhook payload.' }, { status: 400 });
    }
    const headersList = req.headers;

    // Secret key for verification
    const expectedSecret = (
      process.env.NAJIKI_API_KEY ||
      process.env.SCHOOL_SECRET_KEY ||
      process.env.NAJIKI_SECRET_KEY ||
      ''
    ).trim();

    if (!expectedSecret || /^(test_key|changeme|placeholder|your[-_])/i.test(expectedSecret)) {
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
      if (constantTimeEqual(token, expectedSecret)) {
        isAuthorized = true;
      }
    }

    // 2. Verify X-Najiki-Signature header (HMAC-SHA256)
    if (!isAuthorized && signatureHeader) {
      const suppliedSignature = signatureHeader.trim().replace(/^sha256=/i, '');
      if (/^[a-f0-9]{64}$/i.test(suppliedSignature)) {
        const digest = crypto.createHmac('sha256', expectedSecret).update(rawBody).digest('hex');
        isAuthorized = constantTimeEqual(suppliedSignature.toLowerCase(), digest);
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

    // Log only allowlisted operational fields; provider payloads may contain PII
    // in nested metadata or fields whose names change over time.
    console.log('[NaJiki Webhook] Received event:', {
      event: payload.event || payload.eventType || payload.type || payload.event_type || 'unknown',
      id: payload.id || payload.data?.id || null,
      status: payload.status || payload.data?.status || null,
    });

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

      const rawAmount = [
        eventData.amount,
        eventData.value,
        eventData.total,
        eventData.metadata?.amount,
      ].find(value => value !== undefined && value !== null);
      const amount = typeof rawAmount === 'number'
        ? rawAmount
        : typeof rawAmount === 'string' && rawAmount.trim() !== ''
          ? Number(rawAmount)
          : Number.NaN;
      const rawCurrency = eventData.currency ?? eventData.metadata?.currency;
      const validCurrency = rawCurrency === undefined || rawCurrency === null || String(rawCurrency).toUpperCase() === 'UGX';
      const rawTxRef =
        eventData.transaction_ref ||
        eventData.transactionRef ||
        eventData.transaction_id ||
        eventData.transactionId ||
        eventData.reference ||
        eventData.paymentIntentId ||
        eventData.idempotencyKey ||
        eventData.idempotency_key ||
        eventData.ext_ref;
      const txRef = rawTxRef === undefined || rawTxRef === null ? '' : String(rawTxRef).trim();

      if (
        !schoolId ||
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        !validCurrency ||
        !txRef ||
        txRef.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(txRef)
      ) {
        console.warn('[NaJiki Webhook] Missing or invalid payment fields for payment.success', {
          hasSchoolId: Boolean(schoolId),
          validAmount: Number.isSafeInteger(amount) && amount > 0,
          hasStableReference: Boolean(txRef),
        });
        return NextResponse.json(
          { error: 'Missing or invalid payment fields (school, positive whole amount, stable reference)' },
          { status: 400 },
        );
      }

      let targetSchoolId = String(schoolId).trim();
      const isSchoolUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetSchoolId);
      if (!isSchoolUuid) {
        const { data: profile, error: profileError } = await publicAdmin
          .from('profiles')
          .select('id, school_id, code')
          .eq('code', targetSchoolId)
          .maybeSingle();
        if (profileError) {
          console.error('[NaJiki Webhook] Could not resolve payment tenant code:', profileError);
          return NextResponse.json({ error: 'Could not resolve payment tenant.' }, { status: 500 });
        }
        targetSchoolId = profile?.school_id || profile?.id || '';
      }
      if (!targetSchoolId) {
        return NextResponse.json({ error: 'Payment tenant was not found.' }, { status: 400 });
      }

      const { data: existingTx, error: existingTxError } = await publicAdmin
        .from('transactions')
        .select('id')
        .eq('reference', txRef)
        .maybeSingle();
      if (existingTxError) {
        console.error('[NaJiki Webhook] Could not verify transaction idempotency:', existingTxError);
        return NextResponse.json({ error: 'Could not verify payment transaction state.' }, { status: 500 });
      }
      if (existingTx) {
        return NextResponse.json({ success: true, message: 'Transaction already processed', reference: txRef }, { status: 200 });
      }

      // This RPC must atomically update the wallet and insert a uniquely
      // referenced transaction. There is deliberately no multi-request fallback.
      const { data: rpcResult, error: rpcError } = await publicAdmin.rpc('credit_wallet', {
        p_school_id: targetSchoolId,
        p_amount: amount,
        p_tx_ref: txRef,
      });

      if (rpcError) {
        const { data: committedTx, error: verifyError } = await publicAdmin
          .from('transactions')
          .select('id')
          .eq('reference', txRef)
          .maybeSingle();
        if (!verifyError && committedTx) {
          return NextResponse.json({ success: true, message: 'Transaction already processed', reference: txRef }, { status: 200 });
        }
        console.error('[NaJiki Webhook] Atomic credit_wallet RPC failed:', rpcError, verifyError);
        return NextResponse.json({ error: 'Wallet credit could not be committed; retry the webhook.' }, { status: 500 });
      }

      if (rpcResult === false || (rpcResult && typeof rpcResult === 'object' && rpcResult.success === false)) {
        console.error('[NaJiki Webhook] Atomic credit_wallet RPC rejected the payment:', rpcResult);
        return NextResponse.json({ error: 'Wallet credit was not committed; retry the webhook.' }, { status: 500 });
      }

      const { data: committedTx, error: commitVerifyError } = await publicAdmin
        .from('transactions')
        .select('id')
        .eq('reference', txRef)
        .maybeSingle();
      if (commitVerifyError || !committedTx) {
        console.error('[NaJiki Webhook] RPC returned without a durable transaction record:', commitVerifyError);
        return NextResponse.json({ error: 'Wallet transaction was not confirmed; retry the webhook.' }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: `Successfully credited ${amount} UGX to school ${targetSchoolId}`,
        reference: txRef,
      }, { status: 200 });
    }

    // Handle SMS delivery reports
    else if (
      eventType === "message.status" || 
      eventType === "sms_delivery_update" ||
      eventType.includes("sms") ||
      eventType.includes("delivery")
    ) {
      const rawSmsId = eventData.messageId || eventData.smsId || eventData.id || eventData.provider_ref;
      const smsId = rawSmsId === undefined || rawSmsId === null ? '' : String(rawSmsId).trim();
      const statusStr = (eventData.status || '').toString().toUpperCase();
      const isDelivered = ['DELIVERED', 'SENT', 'SUCCESS'].includes(statusStr);
      const isFailed = ['FAILED', 'UNDELIVERED', 'REJECTED', 'EXPIRED', 'ERROR'].includes(statusStr) || statusStr.includes('FAIL');

      if (!smsId || smsId.length > 200 || /[\u0000-\u001f\u007f]/.test(smsId)) {
        return NextResponse.json({ error: 'Missing or invalid SMS delivery reference.' }, { status: 400 });
      }
      if (!isDelivered && !isFailed) {
        return NextResponse.json({ received: true, ignored: true }, { status: 200 });
      }
      const status = isDelivered ? 'sent' : 'failed';

      // Resolve exactly one row, then constrain the write by both its primary
      // key and its school tenant. Ambiguous provider references fail closed.
      const schoolAdmin = createAdminClient();
      const { data: notificationByRef, error: lookupByRefError } = await schoolAdmin
        .from('notifications')
        .select('id, school_id')
        .eq('provider_ref', smsId)
        .maybeSingle();

      if (lookupByRefError) {
        console.error('[NaJiki Webhook] Could not resolve SMS provider reference:', lookupByRefError);
        return NextResponse.json({ error: 'Could not resolve SMS delivery reference.' }, { status: 500 });
      }

      let targetNotification = notificationByRef;
      if (!targetNotification) {
        const { data: notificationById, error: lookupByIdError } = await schoolAdmin
          .from('notifications')
          .select('id, school_id')
          .eq('id', smsId)
          .maybeSingle();

        if (lookupByIdError) {
          console.error('[NaJiki Webhook] Could not resolve SMS notification ID:', lookupByIdError);
          return NextResponse.json({ error: 'Could not resolve SMS delivery reference.' }, { status: 500 });
        }
        targetNotification = notificationById;
      }

      if (!targetNotification?.id || !targetNotification.school_id) {
        return NextResponse.json({ error: 'SMS delivery reference was not found.' }, { status: 404 });
      }

      const { data: updatedNotification, error: updateError } = await schoolAdmin
        .from('notifications')
        .update({ status })
        .eq('id', targetNotification.id)
        .eq('school_id', targetNotification.school_id)
        .select('id')
        .maybeSingle();

      if (updateError) {
        console.error('[NaJiki Webhook] Failed updating tenant-scoped notification status:', updateError);
        return NextResponse.json({ error: 'Could not persist SMS delivery status.' }, { status: 500 });
      }
      if (!updatedNotification) {
        return NextResponse.json({ error: 'SMS delivery reference was not found.' }, { status: 404 });
      }
    }

    return NextResponse.json({ received: true }, { status: 200 });

  } catch (err: any) {
    console.error('[NaJiki Webhook] Error handling webhook:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
