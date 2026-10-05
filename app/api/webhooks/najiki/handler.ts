import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAdminClient, createPublicAdminClient } from '@/utils/supabase/admin';
import { UUID_RE } from '@/lib/tenant';
import { classifyPayment, collectReferences, paidAmount, paidCurrency } from '@/lib/payments/webhook';
import { loadSchoolWallet, isMissingFunction } from '@/lib/payments/wallet';

/**
 * NaJiki payment + SMS delivery webhook.
 *
 * MONEY INTEGRITY (see SECURITY_AUDIT.md Part 5):
 *  - Credits go through school.apply_payment() (migration 05): one DB
 *    transaction, matched to a top-up the school actually started, never more
 *    than the amount requested, exactly once per payment, every webhook logged.
 *  - Errors return 5xx so NaJiki retries; we never answer "OK" for a payment we
 *    failed to record.
 *  - Only real successes count: "payment.success" with status FAILED is not paid.
 *  - Non-UGX payments are not credited as UGX.
 *  - Bodies over 64 KB are refused before parsing.
 *  - NAJIKI_WEBHOOK_SECRET (if set) replaces the outbound API key as the
 *    webhook password.
 */

const MAX_BODY_BYTES = 64 * 1024;

type Json = any;

/** Read the body, refusing anything over MAX_BODY_BYTES (also without Content-Length). */
async function readLimitedBody(req: NextRequest): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function webhookSecret(): { secret: string | null; dedicated: boolean } {
  const dedicated = process.env.NAJIKI_WEBHOOK_SECRET;
  if (dedicated) return { secret: dedicated, dedicated: true };
  // Legacy: the same key the app sends to NaJiki on every API call.
  const legacy = process.env.NAJIKI_API_KEY || process.env.SCHOOL_SECRET_KEY || process.env.NAJIKI_SECRET_KEY || null;
  return { secret: legacy, dedicated: false };
}

function isAuthorized(req: NextRequest, rawBody: string, secret: string): boolean {
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const a = crypto.createHash('sha256').update(token).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  const sig = req.headers.get('x-najiki-signature') || req.headers.get('x-signature') || req.headers.get('x-webhook-signature');
  if (sig) {
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = Buffer.from(sig.replace(/^sha256=/i, '').trim().toLowerCase(), 'utf8');
    const expected = Buffer.from(digest, 'utf8');
    if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

/**
 * MULTI-TENANT: decide which school a payment belongs to.
 *
 * Previously the first truthy field won, and tenant CODES were checked before
 * the explicit school UUID that we send ourselves (externalEntityId /
 * metadata.schoolId). If the payment provider echoed back a shared or
 * ambiguous tenant code, the top-up could be credited to another school's
 * wallet. Any non-UUID string was also interpolated into a PostgREST `.or()`
 * filter.
 *
 * Now:
 *  1. Explicit school UUIDs win. If they disagree, the payment is rejected.
 *  2. Only when no UUID is present is a tenant code resolved, and it must map
 *     to exactly one school.
 *  3. The resolved school must exist.
 */
async function resolveWebhookSchool(publicAdmin: any, eventData: Json): Promise<{ schoolId: string; via: string } | { error: string }> {
  const md = (eventData && typeof eventData.metadata === 'object' && eventData.metadata) || {};
  const uuidCandidates = [
    eventData?.school_id, eventData?.schoolId, md.schoolId, md.school_id,
    eventData?.externalEntityId, eventData?.external_entity_id,
    eventData?.tenant_id, eventData?.tenantId, md.tenantId, md.tenant_id,
  ].filter((v) => typeof v === 'string' && UUID_RE.test(v)).map((v: string) => v.toLowerCase());

  const distinct = Array.from(new Set(uuidCandidates));
  let schoolId: string | null = null;
  let via = 'school_uuid';

  if (distinct.length > 1) {
    return { error: 'Conflicting school identifiers in payment payload' };
  }
  if (distinct.length === 1) {
    schoolId = distinct[0];
  } else {
    const code = [eventData?.tenantCode, eventData?.tenant_code, md.tenantCode, md.tenant_code, eventData?.code]
      .find((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v));
    if (!code) return { error: 'Missing school identifier' };
    via = 'tenant_code';

    const { data: tenants } = await publicAdmin.from('tenants').select('id').eq('code', code).limit(2);
    if (Array.isArray(tenants) && tenants.length === 1 && UUID_RE.test(String(tenants[0].id))) {
      schoolId = String(tenants[0].id).toLowerCase();
    } else if (!tenants || tenants.length === 0) {
      const { data: profiles } = await publicAdmin.from('profiles').select('school_id').eq('code', code).limit(2);
      if (Array.isArray(profiles) && profiles.length === 1 && UUID_RE.test(String(profiles[0].school_id))) {
        schoolId = String(profiles[0].school_id).toLowerCase();
      }
    }
    if (!schoolId) return { error: 'Tenant code does not map to exactly one school' };
  }

  const { data: school, error } = await createAdminClient().from('schools').select('id').eq('id', schoolId).maybeSingle();
  if (error || !school) return { error: 'Unknown school' };
  return { schoolId, via };
}

export async function handleNajikiWebhook(req: NextRequest) {
  try {
    const { secret, dedicated } = webhookSecret();
    if (!secret) {
      console.error('[NaJiki Webhook] No webhook secret configured (NAJIKI_WEBHOOK_SECRET or NAJIKI_API_KEY).');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const rawBody = await readLimitedBody(req);
    if (rawBody === null) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }

    const hasAuth = req.headers.get('authorization') || req.headers.get('x-najiki-signature') ||
      req.headers.get('x-signature') || req.headers.get('x-webhook-signature');
    if (!hasAuth) {
      return NextResponse.json({ error: 'Unauthorized: Missing authentication headers' }, { status: 401 });
    }
    if (!isAuthorized(req, rawBody, secret)) {
      console.warn('[NaJiki Webhook] Unauthorized NaJiki webhook attempt.');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!dedicated) {
      console.warn('[NaJiki Webhook] Authenticated with the outbound API key. Set NAJIKI_WEBHOOK_SECRET to a separate secret.');
    }

    let payload: Json;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }
    if (!payload || typeof payload !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }
    const eventData: Json = (payload.data && typeof payload.data === 'object') ? payload.data : payload;

    // Log without personal data.
    const safe = { ...payload, data: payload.data ? { ...payload.data } : undefined };
    for (const o of [safe, safe.data]) if (o) { delete o.phone; delete o.email; delete o.customer_name; delete o.msisdn; delete o.phoneNumber; delete o.phone_number; }
    console.log('[NaJiki Webhook] Received payload:', JSON.stringify(safe).slice(0, 2000));

    const cls = classifyPayment(payload);
    const isDeliveryReport = !cls.eventType.includes('payment') &&
      (cls.eventType === 'message.status' || cls.eventType === 'sms_delivery_update' ||
       cls.eventType.includes('sms') || cls.eventType.includes('delivery') || cls.eventType.includes('message'));

    if (!isDeliveryReport && cls.isPayment) {
      return await handlePayment(eventData, cls);
    }
    if (isDeliveryReport) {
      await handleDeliveryReport(eventData);
    }
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    console.error('[NaJiki Webhook] Error handling webhook:', err);
    // 5xx: NaJiki will retry. Never acknowledge a payment we failed to record.
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

async function handlePayment(eventData: Json, cls: ReturnType<typeof classifyPayment>) {
  const { refs, providerRef } = collectReferences(eventData);

  if (!cls.isPaid) {
    console.log(`[NaJiki Webhook] Payment not successful (event="${cls.eventType}", status=${cls.statuses.join('/') || 'none'}), ref ${providerRef || refs[0] || '-'}: nothing credited.`);
    return NextResponse.json({ received: true, credited: false, reason: 'not_paid' }, { status: 200 });
  }

  const amount = paidAmount(eventData);
  const currency = paidCurrency(eventData);
  if (refs.length === 0 && !providerRef) {
    return NextResponse.json({ error: 'Missing transaction reference' }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 50_000_000) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  // The school named in the payload is only a CLAIM: the payment is matched to
  // the top-up the school started, and a mismatch is refused.
  const publicAdmin = createPublicAdminClient();
  const resolved = await resolveWebhookSchool(publicAdmin, eventData);
  if ('error' in resolved && resolved.error.startsWith('Conflicting')) {
    console.warn('[NaJiki Webhook] Conflicting school identifiers in payment payload.');
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const claimedSchool = 'schoolId' in resolved ? resolved.schoolId : null;
  const requireIntent = process.env.NAJIKI_REQUIRE_PAYMENT_INTENT !== 'false';

  const { data: result, error } = await createAdminClient().rpc('apply_payment', {
    p_refs: providerRef && !refs.includes(providerRef) ? [...refs, providerRef] : refs,
    p_provider_ref: providerRef,
    p_amount: amount,
    p_currency: currency,
    p_claimed_school: claimedSchool,
    p_require_intent: requireIntent,
    p_detail: { event: cls.eventType, statuses: cls.statuses, via: 'schoolId' in resolved ? resolved.via : null },
  });

  if (error) {
    if (isMissingFunction(error)) {
      console.warn('[NaJiki Webhook] Migration 05 (apply_payment) not installed: using the legacy credit path. Run supabase_migrations/05_sms_payment_integrity.sql.');
      return legacyCredit({ refs, providerRef, amount, currency, claimedSchool });
    }
    console.error('[NaJiki Webhook] apply_payment failed, asking NaJiki to retry:', error.message);
    return NextResponse.json({ error: 'Could not record payment, please retry' }, { status: 500 });
  }

  const outcome = (result && result.outcome) || 'unknown';
  if (outcome === 'credited') {
    console.log(`[NaJiki Webhook] Credited ${result.amount} UGX to school ${result.school_id} (reported ${amount}), ref ${result.reference}. New balance ${result.balance}.`);
    return NextResponse.json({ success: true, credited: Number(result.amount), reference: result.reference }, { status: 200 });
  }
  if (outcome === 'duplicate') {
    console.log(`[NaJiki Webhook] Payment ${providerRef || refs[0]} already processed (idempotency hit).`);
    return NextResponse.json({ success: true, message: 'Transaction already processed' }, { status: 200 });
  }
  // unmatched / school_mismatch / currency_mismatch / invalid_amount / no_school:
  // recorded in school.payment_events for manual reconciliation, NOT credited.
  console.warn(`[NaJiki Webhook] Payment ${providerRef || refs[0]} NOT credited (${outcome}); held in school.payment_events for review.`);
  return NextResponse.json({ received: true, credited: false, outcome }, { status: 202 });
}

/**
 * Used only until migration 05 is installed. Weaker than apply_payment() (no
 * intent matching), but: never acknowledges a payment it failed to record,
 * only treats a unique-violation as "already processed", and updates the
 * balance with compare-and-swap so concurrent payments don't overwrite each other.
 */
// Legacy path: process credits one at a time inside this server process, so
// simultaneous duplicate webhooks can't both pass the "already processed?" check.
// (Across several server instances only migration 05 makes this airtight.)
let legacyQueue: Promise<unknown> = Promise.resolve();
function legacyCredit(p: { refs: string[]; providerRef: string | null; amount: number; currency: string; claimedSchool: string | null }) {
  const run = legacyQueue.then(() => legacyCreditNow(p));
  legacyQueue = run.catch(() => undefined);
  return run;
}

async function legacyCreditNow(p: { refs: string[]; providerRef: string | null; amount: number; currency: string; claimedSchool: string | null }) {
  const { amount, currency, claimedSchool } = p;
  const txRef = (p.providerRef || p.refs[0] || '').slice(0, 200);
  if (currency !== 'UGX') {
    console.warn(`[NaJiki Webhook] Non-UGX payment (${currency}) ${txRef} not credited.`);
    return NextResponse.json({ received: true, credited: false, outcome: 'currency_mismatch' }, { status: 202 });
  }
  if (!claimedSchool) {
    return NextResponse.json({ error: 'Missing school identifier' }, { status: 400 });
  }
  const publicAdmin = createPublicAdminClient();

  const { data: existingTx, error: exErr } = await publicAdmin.from('transactions').select('id').eq('reference', txRef).limit(1);
  if (exErr) throw new Error(`idempotency lookup failed: ${exErr.message}`);
  if (existingTx && existingTx.length > 0) {
    return NextResponse.json({ success: true, message: 'Transaction already processed' }, { status: 200 });
  }

  // Older deployments may have a public.credit_wallet RPC: keep using it if present.
  const { error: rpcError } = await publicAdmin.rpc('credit_wallet', { p_school_id: claimedSchool, p_amount: amount, p_tx_ref: txRef });
  if (!rpcError) {
    return NextResponse.json({ success: true, credited: amount, reference: txRef }, { status: 200 });
  }
  if (!isMissingFunction(rpcError)) {
    throw new Error(`credit_wallet failed: ${rpcError.message}`);
  }

  let wallet = await loadSchoolWallet(publicAdmin, claimedSchool);
  if (!wallet) {
    const { data: school } = await createAdminClient().from('schools').select('settings').eq('id', claimedSchool).maybeSingle();
    const legacyBal = Number(school?.settings?.balance);
    const { data: created, error: wErr } = await publicAdmin.from('wallets')
      .insert({ id: crypto.randomUUID(), tenant_id: claimedSchool, school_id: claimedSchool, balance: Number.isFinite(legacyBal) && legacyBal > 0 ? legacyBal : 0, currency: 'UGX' })
      .select('id, balance, tenant_id, school_id').single();
    if (wErr) throw new Error(`wallet create failed: ${wErr.message}`);
    wallet = created;
  }
  const walletId = wallet!.id;

  // Record the payment first: the reference can only be used once.
  const { error: tErr } = await publicAdmin.from('transactions').insert({
    wallet_id: walletId, amount, type: 'credit', reference: txRef, status: 'completed',
    description: `NaJiki Mobile Money Top-up (+${amount.toLocaleString()} UGX)`,
  });
  if (tErr) {
    if (tErr.code === '23505') {
      return NextResponse.json({ success: true, message: 'Transaction already processed' }, { status: 200 });
    }
    throw new Error(`transaction insert failed: ${tErr.message}`);
  }

  // Compare-and-swap balance update.
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data: cur, error: rErr } = await publicAdmin.from('wallets').select('balance').eq('id', walletId).single();
    if (rErr) break;
    const oldBal = cur.balance;
    const newBal = Number(oldBal || 0) + amount;
    let upd = publicAdmin.from('wallets').update({ balance: newBal }).eq('id', walletId);
    upd = oldBal === null ? upd.is('balance', null) : upd.eq('balance', oldBal);
    const { data: done, error: uErr } = await upd.select('id');
    if (uErr) break;
    if (done && done.length === 1) {
      const { data: school } = await createAdminClient().from('schools').select('settings').eq('id', claimedSchool).maybeSingle();
      if (school) {
        await createAdminClient().from('schools').update({ settings: { ...(school.settings || {}), balance: newBal } }).eq('id', claimedSchool);
      }
      console.log(`[NaJiki Webhook] Credited ${amount} UGX to school ${claimedSchool} (legacy path), ref ${txRef}. New balance ${newBal}.`);
      return NextResponse.json({ success: true, credited: amount, reference: txRef }, { status: 200 });
    }
  }
  // Couldn't apply the balance: undo the ledger row so NaJiki's retry can credit it.
  await publicAdmin.from('transactions').delete().eq('reference', txRef).eq('wallet_id', walletId);
  throw new Error('balance update failed after retries');
}

async function handleDeliveryReport(eventData: Json) {
  const raw = eventData?.messageId || eventData?.smsId || eventData?.id || eventData?.provider_ref;
  const smsId = typeof raw === 'string' || typeof raw === 'number' ? String(raw).slice(0, 200) : '';
  if (!smsId) return;
  const statusStr = String(eventData?.status || '').toUpperCase();
  const status = (statusStr === 'DELIVERED' || statusStr === 'SENT' || statusStr === 'SUCCESS') ? 'sent' : 'failed';
  // Notifications live in the `school` schema (this used the public-schema
  // client before, so delivery reports never reached the queue).
  const admin = createAdminClient();
  const { data: updatedByRef } = await admin.from('notifications').update({ status }).eq('provider_ref', smsId).select('id');
  if ((!updatedByRef || updatedByRef.length === 0) && UUID_RE.test(smsId)) {
    await admin.from('notifications').update({ status }).eq('id', smsId);
  }
}
