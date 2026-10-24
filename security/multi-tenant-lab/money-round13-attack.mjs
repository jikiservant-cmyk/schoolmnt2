// Round 13 Red-Team Money Integrity, Webhook & Concurrency Penetration Test.
// Proves every money/webhook/wallet/delivery vulnerability live against
// PostgreSQL 17.5 + strict PostgREST shim (SHIM_NO_AUTOCOL=1) + production Next.js.
import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';
import pg from 'pg';
import { setupUsers, SHIM, sessionCookie, actionIds as loadActionIds, callAction as rawCallAction } from './lib.mjs';
import seedMod from './seed.js';

const { IDS: { A, B } } = seedMod;
const rawArgs = process.argv.slice(2);
const BASE = rawArgs[0]?.startsWith('http') ? rawArgs[0] : (process.env.BASE || 'http://127.0.0.1:3000');
const APP_DIR = rawArgs[0]?.startsWith('http') ? (rawArgs[1] || '/home/user/schoolmnt2') : (process.env.APP_DIR || '/home/user/schoolmnt2');
const LABEL = (rawArgs[0]?.startsWith('http') ? (rawArgs[2] || 'run') : (rawArgs[0] || 'run')).replace(/[^A-Za-z0-9_.-]/g, '_');
const WEBHOOK_SECRET = process.env.NAJIKI_WEBHOOK_SECRET || 'lab-dedicated-webhook-secret-123';

execSync('node seed.js', { cwd: '/home/user/mt-lab', env: { ...process.env, RLS: '1' } });
await fetch(SHIM + '/__reload', { method: 'POST' });
await setupUsers();

const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

const acts = loadActionIds(APP_DIR);
const cookieA = await sessionCookie('adminA@lab.io');
const cookieB = await sessionCookie('adminB@lab.io');

async function callAction(cookie, fnName, args, path = '/dashboard/attendance', extraHeaders = {}) {
  const entry = (acts[fnName] || [])[0];
  if (!entry) throw new Error(`Missing server action ID for ${fnName}`);
  const r = await rawCallAction(BASE, path, entry.id, args, cookie);
  if (Object.keys(extraHeaders).length > 0) {
    const res = await fetch(BASE + path, {
      method: 'POST',
      body: JSON.stringify(args),
      headers: {
        'Next-Action': entry.id,
        Accept: 'text/x-component',
        Origin: BASE,
        cookie,
        'Content-Type': 'text/plain;charset=UTF-8',
        ...extraHeaders,
      },
      redirect: 'manual',
    });
    const text = await res.text();
    const root = text.split('\n').find((l) => l.startsWith('0:'));
    let value;
    try {
      const parsed = JSON.parse(root.slice(2));
      value = parsed.a;
      if (typeof value === 'string' && value.startsWith('$@')) {
        const ref = value.slice(2);
        const row = text.split('\n').find((l) => l.startsWith(ref + ':'));
        value = row ? JSON.parse(row.slice(ref.length + 1)) : undefined;
      }
    } catch {}
    return { status: res.status, value, raw: text };
  }
  return { status: r.status, value: r.value, raw: r.text };
}

async function hook(payload, endpoint = '/api/webhooks/najiki') {
  const body = JSON.stringify(payload);
  const t = Date.now();
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  const r = await fetch(BASE + endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-najiki-timestamp': String(t),
      'x-najiki-signature': `t=${t},v=${sig}`,
    },
    body,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

const walletBal = async (schoolId) => {
  const rows = await q('SELECT coalesce(sum(balance), 0) AS b FROM public.wallets WHERE tenant_id = $1 OR school_id = $1', [schoolId]);
  return Number(rows[0].b);
};

async function initiateTopUp(cookie, schoolId, amount, phone = '0772123456') {
  const before = await q('SELECT id, reference, provider_ref FROM school.payment_intents WHERE school_id = $1 ORDER BY created_at DESC LIMIT 1', [schoolId]);
  const res = await callAction(cookie, 'topUpBalance', [amount, phone]);
  const after = await q('SELECT id, reference, provider_ref, status, phone FROM school.payment_intents WHERE school_id = $1 ORDER BY created_at DESC LIMIT 1', [schoolId]);
  const created = after[0] && (!before[0] || after[0].id !== before[0].id) ? after[0] : null;
  return { res, intent: created };
}

const results = [];
const broken = [];
const rec = (name, vulnerable, detail) => {
  results.push({ name, vulnerable: !!vulnerable, detail: String(detail) });
  console.log((vulnerable ? 'VULNERABLE ' : 'secure     ') + name + '  [' + detail + ']');
};
const legit = (name, ok, detail) => {
  if (!ok) broken.push(name);
  console.log((ok ? 'legit-ok   ' : 'LEGIT-FAIL ') + name + '  [' + detail + ']');
};

// ============================================================================
// R13-01: Cross-tenant dedupe black hole via placeholder providerPaymentId="N/A"
// ============================================================================
{
  const a0 = await walletBal(A.school);
  const b0 = await walletBal(B.school);
  const initA = await initiateTopUp(cookieA, A.school, 5000);
  const initB = await initiateTopUp(cookieB, B.school, 15000);
  const wA = await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      providerPaymentId: 'N/A',
      amount: 5000,
      currency: 'UGX',
      externalEntityId: A.school,
      metadata: { idempotencyKey: initA.intent.reference, schoolId: A.school },
    },
  });
  const wB = await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      providerPaymentId: 'N/A',
      amount: 15000,
      currency: 'UGX',
      externalEntityId: B.school,
      metadata: { idempotencyKey: initB.intent.reference, schoolId: B.school },
    },
  });
  const a1 = await walletBal(A.school);
  const b1 = await walletBal(B.school);
  rec(
    'R13-01 placeholder providerPaymentId ("N/A") black-holes other schools\' real paid money as duplicate',
    b1 - b0 !== 15000,
    `A delta=${a1 - a0}, B delta=${b1 - b0}, B webhook=${wB.status} ${wB.text.slice(0, 90)}`
  );
  legit('R13-01a School A first payment still credited 5000', a1 - a0 === 5000, `wA=${wA.status} delta=${a1 - a0}`);
}

// ============================================================================
// R13-02: Direct SQL apply_payment trivial-ref poisoning ("0" / "MTN")
// ============================================================================
{
  const b0 = await walletBal(B.school);
  const ref1 = 'sch_topup_' + crypto.randomUUID();
  const ref2 = 'sch_topup_' + crypto.randomUUID();
  await q('INSERT INTO school.payment_intents(school_id, reference, amount) VALUES ($1,$2,2000), ($3,$4,3000)', [A.school, ref1, B.school, ref2]);
  await q("SELECT school.apply_payment(ARRAY[$1, '0', 'MTN']::text[], $2, 2000, 'UGX', $3, true, '{}'::jsonb)", [ref1, crypto.randomUUID(), A.school]);
  const r2 = (await q("SELECT school.apply_payment(ARRAY[$1, '0', 'MTN']::text[], $2, 3000, 'UGX', $3, true, '{}'::jsonb) AS r", [ref2, crypto.randomUUID(), B.school]))[0].r;
  const b1 = await walletBal(B.school);
  rec(
    'R13-02 SQL apply_payment allows trivial shared tags ("0","MTN") to drop unrelated school payments',
    b1 - b0 !== 3000,
    `outcome=${r2?.outcome} B delta=${b1 - b0}`
  );
}

// ============================================================================
// R13-03: Event-name black hole when eventType contains "sms" (e.g. sms_topup.completed)
// ============================================================================
{
  const a0 = await walletBal(A.school);
  const initA = await initiateTopUp(cookieA, A.school, 6000);
  const w = await hook({
    eventType: 'sms_topup.completed',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      amount: 6000,
      currency: 'UGX',
      externalEntityId: A.school,
      metadata: { idempotencyKey: initA.intent.reference, schoolId: A.school },
    },
  });
  const a1 = await walletBal(A.school);
  rec(
    'R13-03 sms_topup.completed misrouted to SMS delivery handler, silently losing paid money',
    a1 - a0 !== 6000,
    `status=${w.status} delta=${a1 - a0} body=${w.text.slice(0, 90)}`
  );
}

// ============================================================================
// R13-04: Outer-envelope foreign currency ("USD") & nested currency object ({code:"KES"})
// ============================================================================
{
  const a0 = await walletBal(A.school);
  const initUsd = await initiateTopUp(cookieA, A.school, 10000);
  const initKes = await initiateTopUp(cookieA, A.school, 10000);
  const wUsd = await hook({
    eventType: 'PAYMENT_COMPLETED',
    currency: 'USD',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      amount: 10000,
      externalEntityId: A.school,
      metadata: { idempotencyKey: initUsd.intent.reference, schoolId: A.school },
    },
  });
  const wKes = await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      amount: 10000,
      currency: { code: 'KES' },
      externalEntityId: A.school,
      metadata: { idempotencyKey: initKes.intent.reference, schoolId: A.school },
    },
  });
  const a1 = await walletBal(A.school);
  rec(
    'R13-04 foreign currency on outer envelope (USD) or object ({code:"KES"}) silently credited as UGX',
    a1 !== a0,
    `delta=${a1 - a0} usd=${wUsd.status} kes=${wKes.status}`
  );
}

// ============================================================================
// R13-05: Sub-shilling fractional dust (0.001) burning a real 50,000 UGX pending intent
// ============================================================================
{
  const a0 = await walletBal(A.school);
  const init50k = await initiateTopUp(cookieA, A.school, 50000);
  const wDust = await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      amount: 0.001,
      currency: 'UGX',
      externalEntityId: A.school,
      metadata: { idempotencyKey: init50k.intent.reference, schoolId: A.school },
    },
  });
  const wReal = await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      amount: 50000,
      currency: 'UGX',
      externalEntityId: A.school,
      metadata: { idempotencyKey: init50k.intent.reference, schoolId: A.school },
    },
  });
  const a1 = await walletBal(A.school);
  rec(
    'R13-05 fractional dust (0.001 UGX) burns pending 50,000 UGX intent and rejects real 50,000 UGX payment',
    a1 - a0 !== 50000,
    `delta=${a1 - a0} dust=${wDust.status} real=${wReal.status} ${wReal.text.slice(0, 80)}`
  );

  // Legit format edge cases: whitespace primary field + amount_paid fallback, and { value, currency } money object
  const b4 = await walletBal(A.school);
  const initFmt1 = await initiateTopUp(cookieA, A.school, 4500);
  const initFmt2 = await initiateTopUp(cookieA, A.school, 3500);
  await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      amount: '   ',
      amount_paid: '4,500.00',
      currency: 'UGX',
      externalEntityId: A.school,
      metadata: { idempotencyKey: initFmt1.intent.reference, schoolId: A.school },
    },
  });
  await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      amount: { value: 3500, currency: 'UGX' },
      externalEntityId: A.school,
      metadata: { idempotencyKey: initFmt2.intent.reference, schoolId: A.school },
    },
  });
  const b5 = await walletBal(A.school);
  legit('R13-05b money envelope ({value,currency}) and whitespace+amount_paid formats credit cleanly', b5 - b4 === 8000, `delta=${b5 - b4}`);
}

// ============================================================================
// R13-06: Outer vs inner envelope conflicting school UUIDs accepted
// ============================================================================
{
  const a0 = await walletBal(A.school);
  const initA = await initiateTopUp(cookieA, A.school, 2500);
  const w = await hook({
    eventType: 'PAYMENT_COMPLETED',
    externalEntityId: B.school,
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      amount: 2500,
      currency: 'UGX',
      schoolId: A.school,
      metadata: { idempotencyKey: initA.intent.reference, schoolId: A.school },
    },
  }, '/api/internal/payment-completed');
  const a1 = await walletBal(A.school);
  rec(
    'R13-06 outer vs inner envelope cross-tenant schoolId conflict accepted',
    w.status === 200 || a1 !== a0,
    `status=${w.status} delta=${a1 - a0}`
  );
}

// ============================================================================
// R13-07: Blank / punctuation-only phone bypass ("         ", "---------") in topUpBalance
// ============================================================================
{
  const spaces = await initiateTopUp(cookieA, A.school, 1000, '         ');
  const dashes = await initiateTopUp(cookieA, A.school, 1000, '---------');
  rec(
    'R13-07 blank/punctuation-only phone ("         " / "---------") creates payment_intent and calls NaJiki',
    Boolean(spaces.intent || dashes.intent || !spaces.res.value?.error || !dashes.res.value?.error),
    `spacesIntent=${!!spaces.intent} dashesIntent=${!!dashes.intent} err=${spaces.res.value?.error || 'NONE'}`
  );
}

// ============================================================================
// R13-08: Cross-tenant profiles.code routing hazard when tenants row missing
// ============================================================================
{
  await q('DELETE FROM public.tenants WHERE id = $1', [A.school]);
  await q('INSERT INTO public.profiles(id, user_id, school_id, code) VALUES ($1, $1, $2, $3)', [A.admin, B.school, 'codeB']);
  const cross = await initiateTopUp(cookieA, A.school, 2000, '0772123456');
  await q('DELETE FROM public.profiles WHERE id = $1', [A.admin]);
  await q("INSERT INTO public.tenants(id, code, name) VALUES ($1, 'codeA', 'Alpha Academy')", [A.school]);
  rec(
    'R13-08 foreign profiles.code routes School A Mobile Money collection into School B NaJiki merchant account',
    !cross.res.value?.error,
    `res=${JSON.stringify(cross.res.value)}`
  );
}

// ============================================================================
// R13-09: Multi-instance TOCTOU race on durable top-up quota (STK push bombing)
// ============================================================================
{
  // Fill School B's recent payment_intents to 995 (limit is TOPUP_MAX_PER_10_MIN = 1000 -> room for ONLY 5 more!).
  // Then blast 15 simultaneous topUpBalance requests from distinct forwarded client IPs (simulating 15 Cloud Run instances / IPs).
  const existing = Number((await q("SELECT count(*) AS n FROM school.payment_intents WHERE school_id = $1 AND created_at >= now() - interval '10 minutes'", [B.school]))[0].n);
  const padCount = Math.max(0, 995 - existing);
  if (padCount > 0) {
    await q(
      `INSERT INTO school.payment_intents (school_id, reference, amount, currency, phone)
       SELECT $1, 'pad_' || g::text || '_' || gen_random_uuid()::text, 500, 'UGX', '256700000000'
       FROM generate_series(1, $2) AS g`,
      [B.school, padCount]
    );
  }
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      callAction(cookieB, 'topUpBalance', [500, '0772999888'], '/dashboard/attendance', {
        'x-forwarded-for': `198.51.100.${10 + i}`,
      })
    )
  );
  const totalAfter = Number((await q("SELECT count(*) AS n FROM school.payment_intents WHERE school_id = $1 AND created_at >= now() - interval '10 minutes'", [B.school]))[0].n);
  await q("DELETE FROM school.payment_intents WHERE school_id = $1 AND reference LIKE 'pad_%'", [B.school]);
  rec(
    'R13-09 concurrent top-up burst races past durable 10-minute payment_intents quota (STK push bomb)',
    totalAfter > 1000,
    `allowed=${totalAfter} (limit=1000)`
  );
}

// ============================================================================
// R13-10: Wallet kernel invariants — cross-tenant hybrid row, negative balance, negative legacy settings.balance, null-balance tie
// ============================================================================
{
  // 10a: Cross-tenant hybrid wallet row via INSERT or UPDATE (tenant_id = B, school_id = A)
  let hybridAccepted = false;
  try {
    await q('UPDATE public.wallets SET tenant_id = $1 WHERE school_id = $2', [B.school, A.school]);
    const rows = await q('SELECT id FROM public.wallets WHERE tenant_id = $1 AND school_id = $2', [B.school, A.school]);
    if (rows.length > 0) {
      hybridAccepted = true;
      await q('UPDATE public.wallets SET tenant_id = $1 WHERE school_id = $1', [A.school]);
    }
  } catch {
    hybridAccepted = false;
  }
  rec('R13-10a cross-tenant hybrid wallet row (tenant_id=B, school_id=A) permitted in public.wallets', hybridAccepted, `hybridAccepted=${hybridAccepted}`);

  // 10b: Negative balance allowed on public.wallets
  const prevBalA = await walletBal(A.school);
  let negAccepted = false;
  try {
    await q('UPDATE public.wallets SET balance = -500 WHERE tenant_id = $1', [A.school]);
    negAccepted = true;
    await q('UPDATE public.wallets SET balance = $2 WHERE tenant_id = $1', [A.school, prevBalA]);
  } catch {
    negAccepted = false;
  }
  rec('R13-10b negative wallet balance (-500 UGX) permitted in public.wallets', negAccepted, `negAccepted=${negAccepted}`);

  // 10c: Stale settings.balance resurrected when wallet_migrated=true and payment_events query errors
  const migSchool = (await q("INSERT INTO school.schools(id, name, settings) VALUES (gen_random_uuid(), 'Migrated Stale School', '{\"balance\": 99999, \"wallet_migrated\": true}') RETURNING id"))[0].id;
  await q('INSERT INTO public.admin_profiles(id, role, app_type, school_id, email) VALUES ($1, $2, $3, $4, $5)', [
    'dddddddd-0000-4000-8000-0000000000a1', 'school_admin', 'school', migSchool, 'adminNull@lab.io',
  ]);
  await q("INSERT INTO school.staff_users(school_id, auth_user_id, staff_role) VALUES ($1, 'dddddddd-0000-4000-8000-0000000000a1', 'admin')", [migSchool]);
  await fetch(SHIM + '/__users', {
    method: 'POST',
    body: JSON.stringify({
      'adminNull@lab.io': { id: 'dddddddd-0000-4000-8000-0000000000a1', email: 'adminNull@lab.io', password: 'Passw0rd!' },
    }),
  });
  const cookieNull = await sessionCookie('adminNull@lab.io');
  const resurrected = (await callAction(cookieNull, 'getSchoolBalance', [])).value;
  rec(
    'R13-10c spent legacy settings.balance (99999) resurrected even when settings.wallet_migrated=true',
    resurrected?.balance !== 0,
    `resurrected=${JSON.stringify(resurrected)}`
  );
}

// ============================================================================
// R13-11: SMS Delivery Report state regression, missing provider_ref column under SHIM_NO_AUTOCOL=1, & cross-tenant scope
// ============================================================================
{
  const notifA = (await q(
    "INSERT INTO school.notifications(school_id, recipient_type, channel, status, message) VALUES ($1,'parent','sms','pending','R13 delivery test A') RETURNING id",
    [A.school]
  ))[0].id;
  const notifB = (await q(
    "INSERT INTO school.notifications(school_id, recipient_type, channel, status, message) VALUES ($1,'parent','sms','pending','R13 delivery test B') RETURNING id",
    [B.school]
  ))[0].id;

  // 11a: Deliver notifA -> 'sent', then send out-of-order delayed carrier 'QUEUED' callback
  await hook({ eventType: 'SMS_DELIVERY_UPDATE', data: { smsId: notifA, status: 'DELIVERED' } });
  const afterDelivered = (await q('SELECT status FROM school.notifications WHERE id = $1', [notifA]))[0].status;
  await hook({ eventType: 'SMS_DELIVERY_UPDATE', data: { smsId: notifA, status: 'QUEUED' } });
  const afterQueuedRetry = (await q('SELECT status FROM school.notifications WHERE id = $1', [notifA]))[0].status;
  rec(
    'R13-11a out-of-order QUEUED delivery callback overwrites already-DELIVERED SMS back to failed',
    afterDelivered !== 'sent' || afterQueuedRetry !== 'sent',
    `afterDelivered=${afterDelivered} afterQueuedRetry=${afterQueuedRetry}`
  );

  // 11b: Cross-tenant delivery tamper (payload specifies School A UUID while targeting School B's notification UUID)
  await hook({ eventType: 'SMS_DELIVERY_UPDATE', schoolId: A.school, data: { smsId: notifB, status: 'DELIVERED', schoolId: A.school } });
  const notifBStatus = (await q('SELECT status FROM school.notifications WHERE id = $1', [notifB]))[0].status;
  rec(
    'R13-11b delivery webhook scoped to School A mutates School B notification status',
    notifBStatus !== 'pending',
    `notifBStatus=${notifBStatus}`
  );

  // 11c: Non-UUID carrier messageId (provider_ref) delivery webhook under strict SHIM_NO_AUTOCOL=1
  let providerRefOk = false;
  try {
    const providerId = 'at_msg_live_' + crypto.randomUUID().slice(0, 8);
    const nRef = (await q(
      "INSERT INTO school.notifications(school_id, recipient_type, channel, status, message, provider_ref) VALUES ($1,'parent','sms','pending','R13 provider_ref test',$2) RETURNING id",
      [A.school, providerId]
    ))[0].id;
    await hook({ eventType: 'SMS_DELIVERY_UPDATE', data: { messageId: providerId, status: 'DELIVERED' } });
    providerRefOk = (await q('SELECT status FROM school.notifications WHERE id = $1', [nRef]))[0].status === 'sent';
  } catch {
    providerRefOk = false;
  }
  rec(
    'R13-11c non-UUID carrier messageId (provider_ref) silently dropped due to missing schema column',
    !providerRefOk,
    `providerRefOk=${providerRefOk}`
  );

  // 11d: Transient DB failure on notifications update swallowed as HTTP 200 (QStash never retries)
  const nFail = (await q(
    "INSERT INTO school.notifications(school_id, recipient_type, channel, status, message) VALUES ($1,'parent','sms','pending','R13 db fail test') RETURNING id",
    [A.school]
  ))[0].id;
  await q("ALTER TABLE school.notifications ADD CONSTRAINT lab_notif_fail CHECK (message <> 'R13 db fail test' OR status = 'pending')");
  const failHook = await hook({ eventType: 'SMS_DELIVERY_UPDATE', data: { smsId: nFail, status: 'DELIVERED' } });
  await q('ALTER TABLE school.notifications DROP CONSTRAINT lab_notif_fail');
  rec(
    'R13-11d DB error during SMS delivery update swallowed with HTTP 200 instead of 500 retry',
    failHook.status >= 200 && failHook.status < 300,
    `status=${failHook.status} ${failHook.text.slice(0, 80)}`
  );
  if (failHook.status >= 500) {
    await hook({ eventType: 'SMS_DELIVERY_UPDATE', data: { smsId: nFail, status: 'DELIVERED' } });
    const retried = (await q('SELECT status FROM school.notifications WHERE id = $1', [nFail]))[0].status;
    legit('R13-11d retry after transient DB failure updates SMS status to sent', retried === 'sent', `status=${retried}`);
  }
}

// ============================================================================
// R13-12: Full Double-Entry Ledger Reconciliation Check Across School A & School B
// ============================================================================
{
  for (const [label, sid] of [['School A', A.school], ['School B', B.school]]) {
    const wBal = await walletBal(sid);
    const evSum = Number((await q("SELECT coalesce(sum(credited_amount), 0) AS s FROM school.payment_events WHERE school_id = $1 AND outcome = 'credited'", [sid]))[0].s);
    const txSum = Number((await q('SELECT coalesce(sum(t.amount), 0) AS s FROM public.transactions t JOIN public.wallets w ON w.id = t.wallet_id WHERE w.tenant_id = $1 OR w.school_id = $1', [sid]))[0].s);
    legit(
      `R13-12 ${label} double-entry reconciliation (wallet=1000+events=1000+transactions)`,
      wBal === 1000 + evSum && evSum === txSum,
      `wallet=${wBal} initial+events=${1000 + evSum} txSum=${txSum}`
    );
  }
}

// ============================================================================
// R13-13: Concurrent SMS wallet debit storm (20 parallel debits on 1500 UGX wallet -> exact 5 succeed, 0 overdraft)
// ============================================================================
{
  const debitSchool = (await q("INSERT INTO school.schools(id, name, settings) VALUES (gen_random_uuid(), 'SMS Debit School', '{}') RETURNING id"))[0].id;
  await q('INSERT INTO public.wallets(tenant_id, school_id, balance) VALUES ($1, $1, 1500)', [debitSchool]);
  const pool = new pg.Pool({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab', max: 12 });
  const debitOutcomes = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      pool.query("SELECT school.debit_sms_wallet($1, 300, $2, 'SMS parallel test') AS r", [debitSchool, `sms_debit_${i}`])
        .then((x) => ({ i, outcome: x.rows[0]?.r?.outcome }))
    )
  );
  // Replay a reference that actually won the race. Picking a fixed one
  // (e.g. sms_debit_0) is non-deterministic: only 5 of the 20 concurrent
  // debits succeed, so a replay of a losing reference correctly answers
  // insufficient_funds instead of duplicate.
  const winner = debitOutcomes.find((x) => x.outcome === 'debited');
  const dupDebit = winner
    ? (await pool.query('SELECT school.debit_sms_wallet($1, 300, $2, $3) AS r', [debitSchool, `sms_debit_${winner.i}`, 'SMS replay test'])).rows[0].r
    : null;
  await pool.end();
  const debitedCount = debitOutcomes.filter((x) => x.outcome === 'debited').length;
  const finalDebitBal = await walletBal(debitSchool);
  rec(
    'R13-13 concurrent SMS wallet debits overdraw balance or double-debit under race',
    debitedCount !== 5 || finalDebitBal !== 0 || dupDebit?.outcome !== 'duplicate',
    `debited=${debitedCount} finalBalance=${finalDebitBal} replay=${dupDebit?.outcome}`
  );
}

// ============================================================================
// R13-14: PostgREST RPC lockdown on new Round 13 functions (anon & authenticated denied)
// ============================================================================
{
  const teacherTok = (await (await fetch(SHIM + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email: 'teacherA@lab.io', password: 'Passw0rd!' }),
  })).json()).access_token;

  let exposed = false;
  for (const bearer of ['lab-anon-key', teacherTok]) {
    for (const [fn, body] of [
      ['create_payment_intent', { p_school_id: A.school, p_reference: 'sch_topup_hack_1234', p_amount: 1000, p_phone: '256772123456' }],
      ['debit_sms_wallet', { p_school_id: A.school, p_amount: 100, p_reference: 'hack_debit_1' }],
      ['clean_payment_refs', { p_refs: ['abc123'] }],
    ]) {
      const r = await fetch(SHIM + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: {
          apikey: 'lab-anon-key',
          Authorization: 'Bearer ' + bearer,
          'Content-Type': 'application/json',
          'Content-Profile': 'school',
        },
        body: JSON.stringify(body),
      });
      if (r.status >= 200 && r.status < 300) exposed = true;
    }
  }
  rec('R13-14 anon or authenticated role can execute school money RPCs directly', exposed, `exposed=${exposed}`);
}

// ============================================================================
// R13-15: 12 simultaneous webhook deliveries of the SAME payment (zero double-credit under race)
// ============================================================================
{
  const a0 = await walletBal(A.school);
  const initRace = await initiateTopUp(cookieA, A.school, 7500);
  const sharedProvId = crypto.randomUUID();
  const racePayload = {
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: sharedProvId,
      amount: 7500,
      currency: 'UGX',
      externalEntityId: A.school,
      metadata: { idempotencyKey: initRace.intent.reference, schoolId: A.school },
    },
  };
  await Promise.all(Array.from({ length: 12 }, () => hook(racePayload)));
  const a1 = await walletBal(A.school);
  rec(
    'R13-15 12 concurrent identical webhook deliveries double-credit wallet',
    a1 - a0 !== 7500,
    `delta=${a1 - a0} (expected 7500)`
  );
}

// ============================================================================
// R13-16: Underpayment & Overpayment caps + HMAC replay/tamper/future/legacy rejection
// ============================================================================
{
  const a0 = await walletBal(A.school);
  const initUnder = await initiateTopUp(cookieA, A.school, 5000);
  const initOver = await initiateTopUp(cookieA, A.school, 5000);
  await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      amount: 3200,
      currency: 'UGX',
      externalEntityId: A.school,
      metadata: { idempotencyKey: initUnder.intent.reference, schoolId: A.school },
    },
  });
  await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      amount: 9000,
      currency: 'UGX',
      externalEntityId: A.school,
      metadata: { idempotencyKey: initOver.intent.reference, schoolId: A.school },
    },
  });
  const a1 = await walletBal(A.school);
  rec(
    'R13-16 underpayment (3200/5000) or overpayment (9000/5000) credits wrong amount (must equal 8200)',
    a1 - a0 !== 8200,
    `delta=${a1 - a0} (expected 8200)`
  );

  // Signature attacks: tampered body, stale (-72h), far-future (+2h), untimestamped legacy
  const validBody = JSON.stringify({ eventType: 'PAYMENT_COMPLETED', data: { status: 'SUCCESS', amount: 5000, reference: 'sch_topup_sigtest' } });
  const now = Date.now();
  const sigCases = [
    // Tampered body after signing
    {
      body: JSON.stringify({ eventType: 'PAYMENT_COMPLETED', data: { status: 'SUCCESS', amount: 500000, reference: 'sch_topup_sigtest' } }),
      headers: {
        'content-type': 'application/json',
        'x-najiki-timestamp': String(now),
        'x-najiki-signature': `t=${now},v=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${now}.${validBody}`).digest('hex')}`,
      },
    },
    // Stale 72h-old signature
    {
      body: validBody,
      headers: (() => {
        const old = now - 72 * 3600 * 1000;
        return {
          'content-type': 'application/json',
          'x-najiki-timestamp': String(old),
          'x-najiki-signature': `t=${old},v=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${old}.${validBody}`).digest('hex')}`,
        };
      })(),
    },
    // Far-future +2h signature
    {
      body: validBody,
      headers: (() => {
        const fut = now + 2 * 3600 * 1000;
        return {
          'content-type': 'application/json',
          'x-najiki-timestamp': String(fut),
          'x-najiki-signature': `t=${fut},v=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${fut}.${validBody}`).digest('hex')}`,
        };
      })(),
    },
    // Legacy untimestamped HMAC without opt-in flag
    {
      body: validBody,
      headers: {
        'content-type': 'application/json',
        'x-najiki-signature': crypto.createHmac('sha256', WEBHOOK_SECRET).update(validBody).digest('hex'),
      },
    },
  ];
  const sigStatuses = await Promise.all(
    sigCases.map((c) => fetch(BASE + '/api/webhooks/najiki', { method: 'POST', headers: c.headers, body: c.body }).then((r) => r.status))
  );
  rec(
    'R13-17 tampered, 72h-stale, +2h-future, or legacy-untimestamped signature accepted without 401',
    sigStatuses.some((s) => s !== 401),
    `statuses=${sigStatuses.join(',')}`
  );

  // R13-19: Static gateway merchant tag (e.g. ext_ref="SMARTSKOOLZ_SMS" length 15) shared across tenants
  // must NOT drop another school's brand-new pending payment, AND stuffing 2 distinct sch_topup_* intents
  // into a single webhook payload MUST be refused as 'ambiguous_intent' (HTTP 202)!
  const aBefore19 = await walletBal(A.school);
  const bBefore19 = await walletBal(B.school);
  const initStaticA = await initiateTopUp(cookieA, A.school, 4000);
  const initStaticB = await initiateTopUp(cookieB, B.school, 11000);
  await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      ext_ref: 'SMARTSKOOLZ_SMS',
      amount: 4000,
      currency: 'UGX',
      externalEntityId: A.school,
      metadata: { idempotencyKey: initStaticA.intent.reference, schoolId: A.school },
    },
  });
  const wStaticB = await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      ext_ref: 'SMARTSKOOLZ_SMS',
      amount: 11000,
      currency: 'UGX',
      externalEntityId: B.school,
      metadata: { idempotencyKey: initStaticB.intent.reference, schoolId: B.school },
    },
  });
  const aAfter19 = await walletBal(A.school);
  const bAfter19 = await walletBal(B.school);
  rec(
    'R13-19 static 15-char gateway tag (ext_ref="SMARTSKOOLZ_SMS") drops other school\'s real paid money',
    aAfter19 - aBefore19 !== 4000 || bAfter19 - bBefore19 !== 11000,
    `A delta=${aAfter19 - aBefore19}, B delta=${bAfter19 - bBefore19} status=${wStaticB.status}`
  );

  // Multi-intent stuffing in one webhook payload
  const stuff1 = await initiateTopUp(cookieA, A.school, 3000);
  const stuff2 = await initiateTopUp(cookieA, A.school, 3000);
  const wStuff = await hook({
    eventType: 'PAYMENT_COMPLETED',
    data: {
      status: 'SUCCESS',
      paymentIntentId: crypto.randomUUID(),
      reference: stuff1.intent.reference,
      tx_ref: stuff2.intent.reference,
      amount: 3000,
      currency: 'UGX',
      externalEntityId: A.school,
    },
  });
  rec(
    'R13-20 multi-intent reference stuffing in a single webhook accepted instead of 202 ambiguous_intent',
    wStuff.status !== 202 || wStuff.json?.outcome !== 'ambiguous_intent',
    `status=${wStuff.status} body=${wStuff.text.slice(0, 90)}`
  );

  // Top-level JSON array payload rejected cleanly with HTTP 400 (not treated as object)
  const wArray = await hook([{ status: 'SUCCESS', amount: 5000, reference: stuff1.intent.reference }]);
  rec(
    'R13-21 top-level JSON array webhook accepted instead of HTTP 400 Invalid JSON payload',
    wArray.status !== 400,
    `status=${wArray.status} body=${wArray.text.slice(0, 80)}`
  );

  // Exact ledger reconciliation STILL holds to the single shilling after ALL 24 checks!
  for (const [label, sid] of [['School A final', A.school], ['School B final', B.school]]) {
    const wBal = await walletBal(sid);
    const evSum = Number((await q("SELECT coalesce(sum(credited_amount), 0) AS s FROM school.payment_events WHERE school_id = $1 AND outcome = 'credited'", [sid]))[0].s);
    const txSum = Number((await q('SELECT coalesce(sum(t.amount), 0) AS s FROM public.transactions t JOIN public.wallets w ON w.id = t.wallet_id WHERE w.tenant_id = $1 OR w.school_id = $1', [sid]))[0].s);
    const mirror = Number((await q("SELECT coalesce((settings->>'balance')::numeric, 0) AS b FROM school.schools WHERE id = $1", [sid]))[0].b);
    legit(
      `R13-22 ${label} 4-way reconciliation (wallet == 1000+events == 1000+transactions == settings.balance)`,
      wBal === 1000 + evSum && evSum === txSum && mirror === wBal,
      `wallet=${wBal} events=${evSum} txSum=${txSum} settingsMirror=${mirror}`
    );
  }
}

// ============================================================================
// R13-18: Unmigrated DB fallback check (MIG11=0) + restore full migrations
// ============================================================================
{
  execSync('node seed.js', { cwd: '/home/user/mt-lab', env: { ...process.env, RLS: '1', MIG11: '0' } });
  await fetch(SHIM + '/__reload', { method: 'POST' });
  await setupUsers();
  const cA2 = await sessionCookie('adminA@lab.io');
  const legacyTopUp = await initiateTopUp(cA2, A.school, 1500, '0772123456');
  const legacyNotif = (await q(
    "INSERT INTO school.notifications(school_id, recipient_type, channel, status, message) VALUES ($1,'parent','sms','pending','unmigrated fallback') RETURNING id",
    [A.school]
  ))[0].id;
  const legacyDeliv = await hook({ eventType: 'SMS_DELIVERY_UPDATE', data: { smsId: legacyNotif, status: 'DELIVERED' } });
  const legacyNotifStatus = (await q('SELECT status FROM school.notifications WHERE id = $1', [legacyNotif]))[0].status;
  legit(
    'R13-18 MIG11=0 unmigrated fallback keeps topUpBalance and UUID SMS delivery working seamlessly',
    !!legacyTopUp.res.value?.success && legacyDeliv.status === 200 && legacyNotifStatus === 'sent',
    `topUp=${!!legacyTopUp.res.value?.success} deliv=${legacyDeliv.status}/${legacyNotifStatus}`
  );

  // Leave database cleanly migrated with full RLS + migrations 03..11
  execSync('node seed.js', { cwd: '/home/user/mt-lab', env: { ...process.env, RLS: '1' } });
  await fetch(SHIM + '/__reload', { method: 'POST' });
  await setupUsers();
}

await db.end();
const vuln = results.filter((r) => r.vulnerable).length;
console.log(`\n[R13 ${LABEL}] ${vuln} vulnerable / ${results.length} red-team checks; legit failures: ${broken.length ? broken.join(', ') : 'none'}`);
fs.writeFileSync(`/home/user/mt-lab/round13-results-${LABEL}.json`, JSON.stringify({ vulnerable: vuln, total: results.length, broken, results }, null, 2));
if (vuln > 0 || broken.length > 0) process.exitCode = 1;
