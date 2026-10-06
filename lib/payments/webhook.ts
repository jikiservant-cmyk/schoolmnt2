/**
 * Parsing helpers for NaJiki payment webhooks.
 *
 * The provider's exact payload shape isn't documented in this repo, so these
 * accept the field names the app has always accepted, but decide strictly:
 *  - a payment counts as successful only if something says "success" AND
 *    nothing says it failed / is pending / was reversed;
 *  - every reference the provider echoes back is collected, so the payment can
 *    be matched to the top-up the app started (school.payment_intents).
 */

const SUCCESS_STATUSES = new Set(['SUCCESS', 'SUCCESSFUL', 'SUCCEEDED', 'COMPLETED', 'COMPLETE', 'PAID']);
const NOT_PAID_STATUSES = new Set([
  'FAILED', 'FAILURE', 'FAIL', 'ERROR', 'CANCELLED', 'CANCELED', 'DECLINED', 'REJECTED',
  'PENDING', 'PROCESSING', 'INITIATED', 'EXPIRED', 'TIMEOUT', 'TIMED_OUT',
  'REVERSED', 'REFUNDED', 'CHARGEBACK', 'INSUFFICIENT_FUNDS',
]);
const SUCCESS_EVENTS = ['payment.success', 'payment_success', 'payment.completed', 'charge.success', 'transaction.success'];
const NOT_PAID_EVENT_WORDS = ['fail', 'cancel', 'revers', 'refund', 'declin', 'pending', 'expire', 'chargeback'];

type Json = any;

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

export function classifyPayment(payload: Json): { eventType: string; isPayment: boolean; isPaid: boolean; statuses: string[] } {
  const data = (payload && typeof payload.data === 'object' && payload.data) || payload || {};
  const eventType = str(payload?.event || payload?.eventType || payload?.type || payload?.event_type).toLowerCase();
  const statuses = [payload?.status, data?.status, data?.payment_status, data?.paymentStatus]
    .map((s) => str(s).trim().toUpperCase())
    .filter(Boolean);

  const successEvent = SUCCESS_EVENTS.some((e) => eventType.includes(e)) || eventType === 'success';
  const successStatus = statuses.some((s) => SUCCESS_STATUSES.has(s));
  const notPaid = statuses.some((s) => NOT_PAID_STATUSES.has(s)) || NOT_PAID_EVENT_WORDS.some((w) => eventType.includes(w));
  const isPayment = eventType.includes('payment') || eventType.includes('charge') || eventType.includes('transaction') ||
    eventType === 'success' || successStatus || (!eventType && statuses.length > 0 && !!(data?.amount ?? data?.value));

  return { eventType, isPayment, isPaid: (successEvent || successStatus) && !notPaid, statuses };
}

/** All references in the payload (ours and the provider's), de-duplicated. */
export function collectReferences(data: Json): { refs: string[]; providerRef: string | null } {
  const md = (data && typeof data.metadata === 'object' && data.metadata) || {};
  const providerRef = [data?.transactionId, data?.transaction_id, data?.transaction_ref, data?.transactionRef, data?.paymentIntentId, data?.payment_id, data?.id]
    .map(str).find((v) => v.length > 0 && v.length <= 200) || null;
  const refs = [
    data?.reference, data?.idempotencyKey, data?.idempotency_key, data?.tx_ref, data?.ext_ref, data?.externalReference, data?.external_reference,
    md.idempotencyKey, md.idempotency_key, md.reference, md.tx_ref,
    data?.transaction_ref, data?.transactionRef, data?.transaction_id, data?.transactionId, data?.paymentIntentId,
    // The mobile money transaction id: lets apply_payment (migration 08)
    // recognise a re-sent notification even when our reference is missing.
    data?.providerPaymentId, data?.provider_payment_id,
  ].map(str).filter((v) => v.length > 0 && v.length <= 200);
  return { refs: Array.from(new Set(refs)), providerRef };
}

/**
 * Amount paid. Provider fields first; our own echoed metadata.amount only as a
 * last resort (as before). apply_payment() never credits more than the top-up
 * the school actually requested, so an inflated value can't add money.
 */
export function paidAmount(data: Json): number {
  const md = (data && typeof data.metadata === 'object' && data.metadata) || {};
  for (const v of [data?.amount, data?.amount_paid, data?.amountPaid, data?.value, data?.total, md.amount]) {
    if (v === undefined || v === null || v === '') continue;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

export function paidCurrency(data: Json): string {
  return str(data?.currency || data?.currency_code || data?.currencyCode).trim().toUpperCase() || 'UGX';
}
