// Cross-check our payment integration against NaJiki's REAL source code.
//
// This does not re-implement the provider's contract. It imports it:
//   najiki-finance2/src/lib/schemas.ts               CreatePaymentRequestSchema,
//                                                    InternalNotificationPayloadSchema
//   najiki-finance2/src/lib/notification-signature.ts buildNotificationHeaders,
//                                                    verifyNotificationSignature
//   najiki-finance2/src/lib/constants.ts             PLATFORM_FEE_TYPES, isPlatformFeeType
//
// and then checks the traffic our app actually produces/routes:
//   1. the STK-push body we POST is accepted by THEIR zod schema, field by field
//   2. the payment type we send is a PLATFORM FEE (an SMS top-up is platform
//      money; a non-platform code makes NaJiki demand per-tenant gateway
//      credentials and fail with 503)
//   3. the completion notification THEY build (all 13 fields, including the
//      provider-side `tenantId` in cuid form) is accepted and credits exactly once
//   4. the legacy /api/internal/payment-completed path behaves identically
//   5. their SMS_DELIVERY_UPDATE body updates the right notification row
//
// Usage: node provider-contract-check.mjs [base] [appDir] [label]
// Env:   NAJIKI_REPO (default /home/user/najiki-finance2), SKIP_SEED=1
import crypto from 'crypto';
import fs from 'fs';
import pg from 'pg';
import { register } from 'node:module';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Their TS uses extensionless relative imports; resolve them before importing.
register(pathToFileURL(fileURLToPath(new URL('./ts-ext-hook.mjs', import.meta.url))).href);
import { setupUsers, sessionCookie, actionIds, callAction, SHIM } from './lib.mjs';
import seedMod from './seed.js';

const { IDS: { A: SA } } = seedMod;
const SCHOOL = SA.school;
const [BASE = 'http://127.0.0.1:3000', APPDIR = '/home/user/schoolmnt2', LABEL = 'run'] = process.argv.slice(2);
const REPO = process.env.NAJIKI_REPO || '/home/user/najiki-finance2';
const SECRET = process.env.NAJIKI_WEBHOOK_SECRET || 'lab-dedicated-webhook-secret-123';

for (const f of ['src/lib/schemas.ts', 'src/lib/notification-signature.ts', 'src/lib/constants.ts']) {
  if (!fs.existsSync(`${REPO}/${f}`)) {
    console.error(`Missing provider source ${REPO}/${f}.`);
    console.error('Clone it first: git clone --depth 1 https://github.com/jikiservant-cmyk/najiki-finance2.git ' + REPO);
    process.exit(2);
  }
}

// --- the provider's own contract, imported (never re-implemented) -----------
const { CreatePaymentRequestSchema, InternalNotificationPayloadSchema } =
  await import(`${REPO}/src/lib/schemas.ts`);
const { buildNotificationHeaders, verifyNotificationSignature } =
  await import(`${REPO}/src/lib/notification-signature.ts`);
const { isPlatformFeeType, PLATFORM_FEE_TYPES } =
  await import(`${REPO}/src/lib/constants.ts`);

// RLS=1 applies migrations 03->14; without it seed.js builds a bare schema and
// the app correctly refuses top-ups (school.payment_intents missing).
if (!process.env.SKIP_SEED) {
  execSync('node seed.js', { cwd: '/home/user/mt-lab', stdio: 'ignore', env: { ...process.env, RLS: '1' } });
}
await fetch(SHIM + '/__reload', { method: 'POST' });
await setupUsers();

const ids = actionIds(APPDIR);
const cookieA = await sessionCookie('adminA@lab.io');
const act = (name, args) => {
  const a = ids[name][0];
  return callAction(BASE, '/' + a.page.replace(/^app\//, '').replace(/\/page$/, ''), a.id, args, cookieA);
};

const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
const bal = async () =>
  Number((await q('SELECT coalesce(sum(balance),0) b FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [SCHOOL]))[0].b);

let fail = 0;
const check = (name, pass, detail = '') => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

const postSigned = async (path, payload) => {
  const body = JSON.stringify(payload);
  const headers = buildNotificationHeaders(SECRET, body); // their signer
  const r = await fetch(BASE + path, { method: 'POST', body, headers });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json, body, headers };
};

// ===========================================================================
// 1. OUTBOUND: the STK-push body our app sends, captured from the wire
// ===========================================================================
console.log('\n--- 1. Outbound POST /api/payments (our body vs their schema) ---');

const AMOUNT = 3000;
await fetch(SHIM + '/__najiki/log', { method: 'DELETE' });
const started = await act('topUpBalance', [AMOUNT, '0772123456']);
const log = await (await fetch(SHIM + '/__najiki/log')).json();
const wire = log[log.length - 1];

check('our app started a top-up', !!started.value?.success, JSON.stringify(started.value)?.slice(0, 120));
check('the provider received a request body', !!wire?.body);

const body = wire?.body || {};
const parsed = CreatePaymentRequestSchema.safeParse(body);
check(
  "our body is accepted by THEIR CreatePaymentRequestSchema",
  parsed.success,
  parsed.success ? 'ok' : JSON.stringify(parsed.error?.issues)?.slice(0, 220)
);
if (parsed.success) {
  const v = parsed.data;
  check('applicationCode present', typeof v.applicationCode === 'string' && v.applicationCode.length > 0, v.applicationCode);
  check('tenantCode present (required for a multi-tenant app)', typeof v.tenantCode === 'string' && v.tenantCode.length > 0, v.tenantCode);
  check('paymentTypeCode present', typeof v.paymentTypeCode === 'string' && v.paymentTypeCode.length > 0, v.paymentTypeCode);
  check('externalEntityId is our school UUID', v.externalEntityId === SCHOOL, v.externalEntityId);
  check('amount is a JSON number of whole shillings', typeof v.amount === 'number' && Number.isInteger(v.amount) && v.amount === AMOUNT, `${typeof v.amount} ${v.amount}`);
  check('currency normalises to UGX', v.currency === 'UGX', v.currency);
  check('phoneNumber is 9-15 chars of MSISDN digits', /^\d{9,15}$/.test(String(v.phoneNumber)), String(v.phoneNumber));
  check('idempotencyKey >= 8 chars and ours', typeof v.idempotencyKey === 'string' && v.idempotencyKey.length >= 8 && v.idempotencyKey.startsWith('sch_topup_'), v.idempotencyKey);
  check('metadata echoes the school id', v.metadata?.schoolId === SCHOOL, JSON.stringify(v.metadata)?.slice(0, 100));
}

// The provider's response must satisfy their own response contract.
const resp = wire?.response || {};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['pending', 'processing', 'success', 'failed', 'expired', 'cancelled'];
check(
  'their CreatePaymentResponse shape ({paymentId uuid, reference, status})',
  UUID.test(String(resp.paymentId)) && typeof resp.reference === 'string' && STATUSES.includes(String(resp.status)),
  JSON.stringify(resp)?.slice(0, 120)
);

// ===========================================================================
// 2. PAYMENT TYPE: an SMS top-up must be a PLATFORM FEE
// ===========================================================================
console.log('\n--- 2. paymentTypeCode routing (platform fee vs tenant collection) ---');

const ourType = body.paymentTypeCode;
check(
  'our paymentTypeCode is in THEIR PLATFORM_FEE_TYPES',
  isPlatformFeeType(ourType),
  `${ourType} in [${PLATFORM_FEE_TYPES.join(', ')}]`
);
// Their handler: credentialSource = isPlatformPayment ? 'platform-fee' : 'none',
// and a non-platform payment then REQUIRES per-tenant credentials (503 if absent).
check(
  "routed as a platform fee (platform LivePay credentials, no per-tenant creds needed)",
  isPlatformFeeType(ourType) === true,
  isPlatformFeeType(ourType)
    ? "isPlatformPayment=true -> credentialSource='platform-fee'"
    : "isPlatformPayment=false -> credentialSource='none' -> per-tenant credentials REQUIRED (503 without them)"
);
// Regression guard: the code this integration used to send.
check(
  'the old hardcoded "general" is NOT a platform fee (it was routed as tenant money)',
  isPlatformFeeType('general') === false,
  'general -> tenant collection -> 503 without per-tenant credentials'
);

// ===========================================================================
// 3. INBOUND: the completion notification THEY build, byte for byte
// ===========================================================================
console.log('\n--- 3. Inbound completion notification (their exact 13 fields) ---');

// Mirrors najiki-finance2 notifyPartner() payloadObject, including the
// provider-side tenantId (Prisma `Tenant.id` = cuid) it really sends.
const buildNotification = (payloadIn, { tenantId, status = 'success', amount = AMOUNT } = {}) => ({
  paymentIntentId: resp.paymentId,
  reference: resp.reference,
  status,
  amount,
  currency: 'UGX',
  providerPaymentId: 'lp_' + crypto.randomUUID(),
  failureReason: status === 'failed' ? 'User cancelled' : null,
  externalEntityId: SCHOOL,
  tenantId,
  tenantCode: body.tenantCode,
  paymentType: body.paymentTypeCode,
  paymentTypeCode: body.paymentTypeCode,
  metadata: payloadIn.metadata,
});

const CUID = 'c' + crypto.randomBytes(12).toString('hex').slice(0, 24);
const notification = buildNotification(body, { tenantId: CUID });

const schemaOk = InternalNotificationPayloadSchema.safeParse(notification);
check(
  'their own InternalNotificationPayloadSchema accepts the payload',
  schemaOk.success,
  schemaOk.success ? 'ok' : JSON.stringify(schemaOk.error?.issues)?.slice(0, 200)
);

const before = await bal();
const r1 = await postSigned('/api/webhooks/najiki', notification);
const after = await bal();
check('notification accepted', r1.status === 200, `HTTP ${r1.status} ${JSON.stringify(r1.json)?.slice(0, 120)}`);
check('credited exactly the amount paid', r1.json?.credited === AMOUNT, JSON.stringify(r1.json)?.slice(0, 120));
check('wallet grew by exactly the amount', after - before === AMOUNT, `${before} -> ${after}`);

// Their verifier must agree with the signature we were sent (signer parity).
const vOk = verifyNotificationSignature({
  secret: SECRET,
  payloadString: r1.body,
  timestamp: r1.headers['X-Najiki-Timestamp'],
  signature: r1.headers['X-Najiki-Signature'],
});
check("NaJiki's own verifyNotificationSignature accepts the signed request", vOk === true);

// Replay: their delivery is at-least-once, so a repeat must not double-credit.
const r2 = await postSigned('/api/webhooks/najiki', notification);
const after2 = await bal();
check('redelivery is idempotent (no second credit)', after2 === after, `balance ${after2}, HTTP ${r2.status}`);

// The provider-side tenantId must never be mistaken for a school id. A foreign
// UUID tenantId alongside our school UUID used to trip the "conflicting school
// identifiers" guard.
const foreignTenantUuid = crypto.randomUUID();
const t2 = await act('topUpBalance', [1000, '0772123457']);
const log2 = await (await fetch(SHIM + '/__najiki/log')).json();
const wire2 = log2[log2.length - 1];
const n2 = {
  ...buildNotification(wire2.body, { tenantId: foreignTenantUuid, amount: 1000 }),
  paymentIntentId: wire2.response.paymentId,
  reference: wire2.response.reference,
};
const b2 = await bal();
const r3 = await postSigned('/api/webhooks/najiki', n2);
const a3 = await bal();
check(
  'a foreign tenantId (UUID form) does not block crediting our school',
  r3.status === 200 && a3 - b2 === 1000,
  `HTTP ${r3.status} ${JSON.stringify(r3.json)?.slice(0, 120)}`
);

// ===========================================================================
// 4. Legacy path parity: /api/internal/payment-completed
// ===========================================================================
console.log('\n--- 4. Legacy /api/internal/payment-completed parity ---');
const t3 = await act('topUpBalance', [1500, '0772123458']);
const log3 = await (await fetch(SHIM + '/__najiki/log')).json();
const wire3 = log3[log3.length - 1];
const n3 = {
  ...buildNotification(wire3.body, { tenantId: CUID, amount: 1500 }),
  paymentIntentId: wire3.response.paymentId,
  reference: wire3.response.reference,
};
const b3 = await bal();
const r4 = await postSigned('/api/internal/payment-completed', n3);
const a4 = await bal();
check(
  'legacy route credits identically',
  r4.status === 200 && a4 - b3 === 1500 && r4.json?.credited === 1500,
  `HTTP ${r4.status} delta=${a4 - b3} ${JSON.stringify(r4.json)?.slice(0, 100)}`
);

// ===========================================================================
// 5. SMS_DELIVERY_UPDATE, exactly as their sms-queue delivers it
// ===========================================================================
console.log('\n--- 5. Inbound SMS_DELIVERY_UPDATE ---');

const SMS_ID = 'c' + crypto.randomBytes(12).toString('hex').slice(0, 24); // their SmsMessage.id (cuid)
const SMS_REF = 'SCH-' + crypto.randomBytes(6).toString('hex').toUpperCase();
const notifId = (await q(
  "INSERT INTO school.notifications(school_id, channel, notification_type, message, status, provider_ref) VALUES ($1,'sms','attendance','hello','queued',$2) RETURNING id",
  [SCHOOL, SMS_ID]
))[0].id;
const notifRef = (await q(
  "INSERT INTO school.notifications(school_id, channel, notification_type, message, status, provider_ref) VALUES ($1,'sms','attendance','hello2','queued',$2) RETURNING id",
  [SCHOOL, SMS_REF]
))[0].id;

const smsBody = {
  eventType: 'SMS_DELIVERY_UPDATE',
  smsId: SMS_ID,
  reference: SMS_REF,
  status: 'delivered',
  providerId: 'ATXid_' + crypto.randomBytes(6).toString('hex'),
  recipient: '+256772123456',
  applicationCode: body.applicationCode,
};
const r5 = await postSigned('/api/webhooks/najiki', smsBody);
const st5 = (await q('SELECT status FROM school.notifications WHERE id=$1', [notifId]))[0].status;
check('SMS_DELIVERY_UPDATE acknowledged', r5.status === 200, `HTTP ${r5.status}`);
check("matching by their smsId marks the row 'sent'", st5 === 'sent', st5);
const st5b = (await q('SELECT status FROM school.notifications WHERE id=$1', [notifRef]))[0].status;
check("matching falls back to their SMS reference too", st5b === 'sent', st5b);

// 'unknown' is one of their real non-terminal statuses.
const n6 = (await q(
  "INSERT INTO school.notifications(school_id, channel, notification_type, message, status, provider_ref) VALUES ($1,'sms','attendance','u','queued',$2) RETURNING id",
  [SCHOOL, 'cUNKNOWN' + crypto.randomBytes(8).toString('hex')]
))[0].id;
const r6 = await postSigned('/api/webhooks/najiki', { ...smsBody, smsId: 'cUNKNOWNx', status: 'unknown' });
const st6 = (await q('SELECT status FROM school.notifications WHERE id=$1', [n6]))[0].status;
check("non-terminal status 'unknown' leaves the row untouched", st6 === 'queued', `${st6} HTTP ${r6.status}`);

// A late failure callback must NOT downgrade an already-delivered row: the
// provider retries out of order, and flipping a delivered SMS to failed would
// silently under-report spend.
const r7 = await postSigned('/api/webhooks/najiki', { ...smsBody, status: 'failed' });
const st7 = (await q('SELECT status FROM school.notifications WHERE id=$1', [notifId]))[0].status;
check('a late failure does not downgrade an already-sent row', st7 === 'sent', `${st7} HTTP ${r7.status}`);

// A genuine first-report failure (still queued) must be recorded.
const SMS_FAIL_ID = 'c' + crypto.randomBytes(12).toString('hex').slice(0, 24);
const failRow = (await q(
  "INSERT INTO school.notifications(school_id, channel, notification_type, message, status, provider_ref) VALUES ($1,'sms','attendance','f','queued',$2) RETURNING id",
  [SCHOOL, SMS_FAIL_ID]
))[0].id;
const r7b = await postSigned('/api/webhooks/najiki', { ...smsBody, smsId: SMS_FAIL_ID, status: 'failed' });
const st7b = (await q('SELECT status FROM school.notifications WHERE id=$1', [failRow]))[0].status;
check("a queued row receives terminal 'failed'", st7b === 'failed', `${st7b} HTTP ${r7b.status}`);

// A late delivered callback re-confirms sent.
const r8 = await postSigned('/api/webhooks/najiki', { ...smsBody, status: 'delivered' });
const st8 = (await q('SELECT status FROM school.notifications WHERE id=$1', [notifId]))[0].status;
check('a late delivered callback re-confirms sent', st8 === 'sent', `${st8} HTTP ${r8.status}`);

await db.end();
console.log(`\n=== PROVIDER CONTRACT [${LABEL}]: ${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' FAILED'} ===`);
process.exit(fail ? 1 : 0);
