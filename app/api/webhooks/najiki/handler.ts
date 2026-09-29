import { NextRequest, NextResponse } from 'next/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import crypto from 'crypto';
import { exceedsBodyLimit, exceedsContentLength, MAX_WEBHOOK_BODY_BYTES } from '@/lib/request-limits';

function timingSafeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getTextValue(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).trim();
  return result && result.length <= maxLength ? result : null;
}

export async function handleNajikiWebhook(req: NextRequest) {
  try {
    if (exceedsContentLength(req, MAX_WEBHOOK_BODY_BYTES)) {
      return NextResponse.json({ error: 'Request body is too large' }, { status: 413 });
    }

    const rawBody = await req.text();
    if (exceedsBodyLimit(rawBody, MAX_WEBHOOK_BODY_BYTES)) {
      return NextResponse.json({ error: 'Request body is too large' }, { status: 413 });
    }

    const expectedSecret = (
      process.env.NAJIKI_API_KEY ||
      process.env.SCHOOL_SECRET_KEY ||
      process.env.NAJIKI_SECRET_KEY
    )?.trim();

    if (!expectedSecret) {
      console.error('[NaJiki Webhook] Missing webhook secret configuration.');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const authHeader = req.headers.get('authorization');
    const signatureHeader =
      req.headers.get('x-najiki-signature') ||
      req.headers.get('x-signature') ||
      req.headers.get('x-webhook-signature');

    let isAuthorized = false;
    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      isAuthorized = timingSafeEqualText(token, expectedSecret);
    }

    if (!isAuthorized && signatureHeader) {
      const suppliedSignature = signatureHeader.replace(/^sha256=/i, '').trim().toLowerCase();
      const digest = crypto.createHmac('sha256', expectedSecret).update(rawBody).digest('hex');
      isAuthorized = timingSafeEqualText(suppliedSignature, digest);
    }

    if (!isAuthorized) {
      console.warn('[NaJiki Webhook] Unauthorized webhook attempt.');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let payload: Record<string, any>;
    try {
      const parsed = JSON.parse(rawBody);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
      }
      payload = parsed;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const eventData = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? payload.data
      : payload;
    const eventType = String(
      payload.event || payload.eventType || payload.type || payload.event_type || ''
    ).toLowerCase();
    const rawStatus = String(payload.status || payload.data?.status || '').toUpperCase();
    const publicAdmin = createPublicAdminClient();

    // Log only bounded, non-sensitive routing information. Do not log the
    // provider payload because it can contain customer PII or credentials.
    console.log('[NaJiki Webhook] Received event:', { eventType, status: rawStatus });

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
      const schoolIdentifier =
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
      const schoolId = getTextValue(schoolIdentifier, 100);
      const amount = Number(
        eventData.amount ||
        eventData.value ||
        eventData.total ||
        eventData.metadata?.amount
      );
      const txRef = getTextValue(
        eventData.transaction_ref ||
        eventData.transactionRef ||
        eventData.transaction_id ||
        eventData.transactionId ||
        eventData.reference ||
        eventData.paymentIntentId ||
        eventData.idempotencyKey ||
        eventData.idempotency_key ||
        eventData.ext_ref
      );

      // Never synthesize a reference. Without a provider-owned stable
      // reference, a retry cannot be distinguished from a new payment.
      if (!schoolId || !Number.isSafeInteger(amount) || amount <= 0 || !txRef) {
        return NextResponse.json(
          { error: 'Missing or invalid payment fields (schoolId, amount, reference)' },
          { status: 400 }
        );
      }

      let targetSchoolId = schoolId;
      const { data: profile, error: profileError } = await publicAdmin
        .from('profiles')
        .select('id, school_id')
        .eq('code', schoolId)
        .maybeSingle();

      if (profileError) {
        console.error('[NaJiki Webhook] Tenant lookup failed:', profileError.code);
        return NextResponse.json({ error: 'Unable to resolve payment tenant' }, { status: 503 });
      }
      if (profile?.school_id) targetSchoolId = profile.school_id;
      else if (profile?.id) targetSchoolId = profile.id;

      const { data: existingTx, error: transactionLookupError } = await publicAdmin
        .from('transactions')
        .select('id')
        .eq('reference', txRef)
        .maybeSingle();

      if (transactionLookupError) {
        console.error('[NaJiki Webhook] Idempotency lookup failed:', transactionLookupError.code);
        return NextResponse.json({ error: 'Unable to verify payment status' }, { status: 503 });
      }

      if (existingTx) {
        return NextResponse.json({ success: true, message: 'Transaction already processed' });
      }

      // credit_wallet must perform the transaction insert and balance update in
      // one database transaction, protected by a unique reference constraint.
      // Do not fall back to a read-then-write balance update: concurrent
      // callbacks would lose credits, and a timeout could double-credit.
      const { error: creditError } = await publicAdmin.rpc('credit_wallet', {
        p_school_id: targetSchoolId,
        p_amount: amount,
        p_tx_ref: txRef,
      });

      if (creditError) {
        console.error('[NaJiki Webhook] Atomic wallet credit failed:', creditError.code);
        return NextResponse.json({ error: 'Payment could not be applied' }, { status: 503 });
      }

      return NextResponse.json({
        success: true,
        message: 'Payment credited successfully',
        reference: txRef,
      });
    }

    // Handle SMS delivery reports.
    if (
      eventType === 'message.status' ||
      eventType === 'sms_delivery_update' ||
      eventType.includes('sms') ||
      eventType.includes('delivery')
    ) {
      const smsId = getTextValue(
        eventData.messageId || eventData.smsId || eventData.id || eventData.provider_ref
      );
      const statusString = String(eventData.status || '').toUpperCase();
      const status = ['DELIVERED', 'SENT', 'SUCCESS'].includes(statusString) ? 'sent' : 'failed';

      if (smsId) {
        const { data: updatedByRef, error: providerUpdateError } = await publicAdmin
          .from('notifications')
          .update({ status })
          .eq('provider_ref', smsId)
          .select('id');

        if (providerUpdateError) {
          console.error('[NaJiki Webhook] Notification update failed:', providerUpdateError.code);
          return NextResponse.json({ error: 'Unable to update delivery status' }, { status: 503 });
        }

        if (!updatedByRef || updatedByRef.length === 0) {
          const { error: idUpdateError } = await publicAdmin
            .from('notifications')
            .update({ status })
            .eq('id', smsId);
          if (idUpdateError) {
            console.error('[NaJiki Webhook] Notification fallback update failed:', idUpdateError.code);
            return NextResponse.json({ error: 'Unable to update delivery status' }, { status: 503 });
          }
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error(
      '[NaJiki Webhook] Error handling webhook:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
