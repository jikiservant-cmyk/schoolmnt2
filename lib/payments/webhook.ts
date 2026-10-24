/**
 * Parsing helpers for NaJiki payment webhooks.
 *
 * The provider's exact payload shape isn't documented in this repo, so these
 * accept the field names the app has always accepted, but decide strictly:
 *  - a payment counts as successful only if something says "success" AND
 *    nothing says it failed / is pending / was reversed;
 *  - every genuine reference the provider echoes back is collected, filtering
 *    out shared placeholders ("N/A", "0", "MTN", etc.) so deduplication across
 *    schools never collides;
 *  - UGX amounts must be whole positive shillings (>= 1), and currency is
 *    inspected across both outer and inner webhook envelopes without silently
 *    coercing foreign or malformed currency tags to 'UGX'.
 */

const SUCCESS_STATUSES = new Set(['SUCCESS', 'SUCCESSFUL', 'SUCCEEDED', 'COMPLETED', 'COMPLETE', 'PAID']);
const NOT_PAID_STATUSES = new Set([
  'FAILED', 'FAILURE', 'FAIL', 'ERROR', 'CANCELLED', 'CANCELED', 'DECLINED', 'REJECTED',
  'PENDING', 'PROCESSING', 'INITIATED', 'EXPIRED', 'TIMEOUT', 'TIMED_OUT',
  'REVERSED', 'REFUNDED', 'CHARGEBACK', 'INSUFFICIENT_FUNDS',
]);
const SUCCESS_EVENTS = [
  'payment.success', 'payment_success', 'payment.completed',
  'charge.success', 'transaction.success', 'topup.completed', 'topup.success',
];
const NOT_PAID_EVENT_WORDS = ['fail', 'cancel', 'revers', 'refund', 'declin', 'pending', 'expire', 'chargeback'];

const PLACEHOLDER_REFS = new Set([
  '0', 'null', 'undefined', 'none', 'n/a', 'na', 'nil', 'unknown',
  'pending', 'failed', 'failure', 'success', 'succeeded', 'completed', 'paid',
  'true', 'false', 'test', 'general', 'topup', 'top-up', 'top_up',
  'school', 'mtn', 'airtel', 'ugx', 'sms', 'credit', 'wallet', 'payment',
]);

type Json = any;

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

export function cleanReferenceToken(v: unknown): string {
  const s = str(v).trim();
  if (!s || s.length < 4 || s.length > 200) return '';
  if (PLACEHOLDER_REFS.has(s.toLowerCase())) return '';
  return s;
}

/** True when the payload carries unmistakable payment/top-up identifiers. */
export function hasPaymentIndicators(payload: Json): boolean {
  const data = (payload && typeof payload.data === 'object' && payload.data) || payload || {};
  const md = (data && typeof data.metadata === 'object' && data.metadata) || {};
  const outerMd = (payload && typeof payload.metadata === 'object' && payload.metadata) || {};
  if (cleanReferenceToken(data?.paymentIntentId || payload?.paymentIntentId || data?.providerPaymentId || data?.provider_payment_id)) {
    return true;
  }
  const refs = [
    data?.reference, data?.idempotencyKey, data?.idempotency_key,
    md?.idempotencyKey, md?.idempotency_key, md?.reference,
    outerMd?.idempotencyKey, outerMd?.idempotency_key, outerMd?.reference,
  ].map(str);
  if (refs.some((r) => r.startsWith('sch_topup_'))) {
    return true;
  }
  return false;
}

export function classifyPayment(payload: Json): { eventType: string; isPayment: boolean; isPaid: boolean; statuses: string[] } {
  const data = (payload && typeof payload.data === 'object' && payload.data) || payload || {};
  const eventType = str(payload?.event || payload?.eventType || payload?.type || payload?.event_type).toLowerCase();
  const statuses = [payload?.status, data?.status, data?.payment_status, data?.paymentStatus]
    .map((s) => str(s).trim().toUpperCase())
    .filter(Boolean);

  const successEvent = SUCCESS_EVENTS.some((e) => eventType.includes(e)) || eventType === 'success';
  const successStatus = statuses.some((s) => SUCCESS_STATUSES.has(s));
  const notPaid = statuses.some((s) => NOT_PAID_STATUSES.has(s)) || NOT_PAID_EVENT_WORDS.some((w) => eventType.includes(w));
  const isPayment =
    hasPaymentIndicators(payload) ||
    eventType.includes('payment') ||
    eventType.includes('charge') ||
    eventType.includes('transaction') ||
    eventType.includes('collection') ||
    eventType.includes('topup') ||
    eventType.includes('top_up') ||
    eventType.includes('top-up') ||
    eventType.includes('wallet') ||
    eventType === 'success' ||
    successStatus ||
    (!eventType && statuses.length > 0 && !!(data?.amount ?? data?.value));

  return { eventType, isPayment, isPaid: (successEvent || successStatus) && !notPaid, statuses };
}

/** All clean transaction references in the payload (ours and the provider's), de-duplicated. */
export function collectReferences(data: Json): { refs: string[]; providerRef: string | null } {
  const md = (data && typeof data.metadata === 'object' && data.metadata) || {};
  const providerRef = [
    data?.transactionId, data?.transaction_id, data?.transaction_ref,
    data?.transactionRef, data?.paymentIntentId, data?.payment_id, data?.id,
  ].map(cleanReferenceToken).find(Boolean) || null;

  const refs = [
    data?.reference, data?.idempotencyKey, data?.idempotency_key, data?.tx_ref,
    data?.ext_ref, data?.externalReference, data?.external_reference,
    md.idempotencyKey, md.idempotency_key, md.reference, md.tx_ref,
    data?.transaction_ref, data?.transactionRef, data?.transaction_id, data?.transactionId, data?.paymentIntentId,
    // Mobile money receipt / provider tx id: cleaned so placeholder values like
    // "N/A" or "0" never poison cross-school deduplication.
    data?.providerPaymentId, data?.provider_payment_id,
  ].map(cleanReferenceToken).filter(Boolean);

  return { refs: Array.from(new Set(refs)), providerRef };
}

/**
 * Amount paid in whole UGX shillings (>= 1).
 * Unwraps money objects `{ value, currency }`, skips empty/whitespace fields so
 * valid fallbacks (`amount_paid`, `metadata.amount`) work, and rejects
 * sub-shilling fractions (`0.001`) or non-numeric garbage as `NaN`.
 */
export function paidAmount(data: Json): number {
  const md = (data && typeof data.metadata === 'object' && data.metadata) || {};
  for (let raw of [data?.amount, data?.amount_paid, data?.amountPaid, data?.value, data?.total, md.amount]) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      raw = raw.value ?? raw.amount;
      if (raw === undefined || raw === null) continue;
    }
    if (typeof raw === 'string') {
      const cleaned = raw.trim().replace(/,/g, '');
      if (cleaned === '') continue;
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN;
      const n = Number(cleaned);
      return Number.isFinite(n) && n >= 1 && Number.isInteger(n) ? n : NaN;
    }
    if (typeof raw === 'number') {
      return Number.isFinite(raw) && raw >= 1 && Number.isInteger(raw) ? raw : NaN;
    }
    return NaN;
  }
  return NaN;
}

/**
 * Resolve currency across BOTH outer envelope and inner `data` + `amount` object + `metadata`.
 * Never coerces foreign (`USD`/`KES`) or malformed non-string currencies into `'UGX'`.
 */
export function paidCurrency(data: Json, outerPayload?: Json): string {
  const md = (data && typeof data.metadata === 'object' && data.metadata) || {};
  const outerMd = (outerPayload && typeof outerPayload.metadata === 'object' && outerPayload.metadata) || {};
  const amtObj = (data && typeof data.amount === 'object' && !Array.isArray(data.amount) && data.amount) || null;

  const candidates = [
    outerPayload?.currency, outerPayload?.currency_code, outerPayload?.currencyCode,
    data?.currency, data?.currency_code, data?.currencyCode,
    amtObj?.currency, amtObj?.currency_code, amtObj?.currencyCode,
    md?.currency, md?.currency_code, md?.currencyCode,
    outerMd?.currency, outerMd?.currency_code, outerMd?.currencyCode,
  ];

  const found: string[] = [];
  for (let c of candidates) {
    if (c === undefined || c === null) continue;
    if (typeof c === 'object' && !Array.isArray(c)) {
      c = c.code ?? c.currency ?? c.currencyCode ?? c.iso;
    }
    if (typeof c !== 'string') return 'INVALID';
    const norm = c.trim().toUpperCase();
    if (!norm) continue;
    if (!found.includes(norm)) found.push(norm);
  }

  if (found.length === 0) return 'UGX';
  if (found.length > 1) return 'CONFLICT';
  return found[0];
}
