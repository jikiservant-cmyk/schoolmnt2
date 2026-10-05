// SMS wallet / payment integrity pentest.
// Usage: node payments-attack.mjs <base> <appDir> <label>   (re-seeds the DB; honours RLS=1)
import pg from 'pg';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { setupUsers, sessionCookie, actionIds, callAction, SHIM } from './lib.mjs';
import seedMod from './seed.js';
const { IDS: { A, B } } = seedMod;
const [BASE, APPDIR, LABEL = 'run'] = process.argv.slice(2);
const SECRET = process.env.NAJIKI_WEBHOOK_SECRET || process.env.NAJIKI_API_KEY || 'lab-najiki-secret';

execSync('node seed.js', { cwd: '/home/user/mt-lab' });
await fetch(SHIM + '/__reload', { method: 'POST' });
await setupUsers();
const ck = await sessionCookie('adminA@lab.io');
const ids = actionIds(APPDIR);
const act = (n, args) => { const a = ids[n][0]; return callAction(BASE, '/' + a.page.replace(/^app\//, '').replace(/\/page$/, ''), a.id, args, ck); };
const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
const bal = async (school) => Number((await q('SELECT coalesce(sum(balance),0) b FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [school]))[0].b);
const wallets = async (school) => Number((await q('SELECT count(*) n FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [school]))[0].n);

const results = [];
const rec = (name, vuln, detail) => { results.push({ name, vulnerable: !!vuln, detail: String(detail ?? '') }); console.log((vuln ? 'VULNERABLE ' : 'secure     ') + name + '  [' + String(detail ?? '').slice(0, 170) + ']'); };
const broken = [];
const legit = (name, pass, detail) => { if (!pass) broken.push(name); console.log((pass ? 'legit-ok   ' : 'LEGIT-FAIL ') + name + '  [' + String(detail ?? '').slice(0, 170) + ']'); };

// Exact copy of najiki-finance2 src/lib/notification-signature.ts buildNotificationHeaders().
const najikiHeaders = (secret, payloadString, now = Date.now()) => {
  const h = { 'Content-Type': 'application/json', 'X-Najiki-Notification': 'true' };
  if (secret) {
    const sig = crypto.createHmac('sha256', secret).update(`${now}.${payloadString}`).digest('hex');
    h['X-Najiki-Timestamp'] = String(now);
    h['X-Najiki-Signature'] = `t=${now},v=${sig}`;
  }
  return h;
};
// Webhook as NaJiki sends it: flat JSON body (no event wrapper), timestamped HMAC.
// `event` wraps the body only for attacks that play with event names.
const hook = async (data, { event = null, auth = 'najiki', secret = SECRET, raw, at, headersOverride } = {}) => {
  const body = raw ?? JSON.stringify(event ? { event, data } : data);
  let headers = { 'content-type': 'application/json' };
  if (auth === 'najiki') headers = najikiHeaders(secret, body, at ?? Date.now());
  if (auth === 'bearer') headers.authorization = 'Bearer ' + secret;
  if (auth === 'hmac') headers['x-najiki-signature'] = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (headersOverride) headers = { ...headers, ...headersOverride };
  const r = await fetch(BASE + '/api/webhooks/najiki', { method: 'POST', headers, body });
  return { status: r.status, text: (await r.text()).slice(0, 200) };
};
// School A's admin starts a real top-up through the app; returns the reference sent to NaJiki.
const initiate = async (amount) => {
  await fetch(SHIM + '/__najiki/log', { method: 'DELETE' });
  const r = await act('topUpBalance', [amount, '0772123456']);
  const log = await (await fetch(SHIM + '/__najiki/log')).json();
  const last = log[log.length - 1];
  const ref = last && last.body.idempotencyKey;
  if (ref && last.response) NJ.set(ref, last.response);
  return { ok: !!(r.value && r.value.success), ref, sent: last, value: r.value };
};
const NJ = new Map(); // our reference -> NaJiki's { paymentId, reference }
// The completion notification exactly as najiki-finance2 completePayment() builds it:
// NaJiki's own paymentIntentId + reference; our metadata echoed back untouched.
const paid = (ref, amount, extra = {}) => {
  const nj = NJ.get(ref) || { paymentId: crypto.randomUUID(), reference: 'SCHOOL-PAY-' + crypto.randomBytes(4).toString('hex').toUpperCase() };
  return { paymentIntentId: nj.paymentId, reference: nj.reference, status: 'success', amount, currency: 'UGX',
    providerPaymentId: 'lp_' + crypto.randomUUID(), failureReason: null, externalEntityId: A.school,
    metadata: { type: 'topup', schoolId: A.school, schoolName: 'School A', tenantCode: 'codeA', amount, idempotencyKey: ref }, ...extra };
};

// ---------- legit flow (must keep working) ----------
let b0 = await bal(A.school);
const t1 = await initiate(2000);
legit('top-up request passes NaJiki request validation (CreatePaymentRequestSchema)', t1.ok && t1.ref && t1.sent.body.externalEntityId === A.school, JSON.stringify(t1.value).slice(0, 120));
const pi1 = process.env.MIG05 === '0' ? null : (await q('SELECT provider_ref FROM school.payment_intents WHERE reference=$1', [t1.ref]))[0];
legit("NaJiki's paymentId stored on the school's intent", process.env.MIG05 === '0' || (pi1 && pi1.provider_ref === NJ.get(t1.ref)?.paymentId), JSON.stringify(pi1));
const body1 = paid(t1.ref, 2000);
let r = await hook(body1);
legit('paid webhook credits exactly the amount', r.status === 200 && (await bal(A.school)) - b0 === 2000, r.status + ' delta=' + ((await bal(A.school)) - b0));
b0 = await bal(A.school);
r = await hook(body1);
legit('same webhook again is accepted but not credited twice', r.status === 200 && (await bal(A.school)) === b0, r.status + ' delta=' + ((await bal(A.school)) - b0));
b0 = await bal(A.school);
const t1h = await initiate(1500);
// QStash retries re-send the ORIGINAL headers; a retry ~47h later must still credit.
r = await hook(paid(t1h.ref, 1500), { at: Date.now() - 47 * 3600 * 1000 });
legit('QStash retry with 47h-old original signature still credits', r.status === 200 && (await bal(A.school)) - b0 === 1500, r.status + ' delta=' + ((await bal(A.school)) - b0));
// Matching by NaJiki paymentId alone (metadata dropped) still finds the right top-up.
b0 = await bal(A.school);
const t1m = await initiate(1700);
const pm = paid(t1m.ref, 1700); delete pm.metadata; pm.externalEntityId = A.school;
r = await hook(pm);
legit('payment matched by NaJiki paymentId when metadata is missing', process.env.MIG05 === '0' || (r.status === 200 && (await bal(A.school)) - b0 === 1700), r.status + ' delta=' + ((await bal(A.school)) - b0));
const gb = await act('getSchoolBalance', []);
legit('dashboard balance matches wallet', gb.value && gb.value.balance === (await bal(A.school)), JSON.stringify(gb.value) + ' wallet=' + (await bal(A.school)));

// ---------- attacks ----------
// P1: credit for a payment nobody started (forged / misrouted webhook)
let bB = await bal(B.school);
r = await hook({ status: 'SUCCESS', amount: 5000000, currency: 'UGX', transactionId: 'nj_forged_' + Date.now(), reference: 'free-money-' + Date.now(), metadata: { schoolId: B.school } });
rec('P1 credit for a payment that was never initiated', (await bal(B.school)) > bB, r.status + ' B delta=' + ((await bal(B.school)) - bB));

// P2: webhook reports more money than the school actually asked to pay
b0 = await bal(A.school);
const t2 = await initiate(1000);
r = await hook(paid(t2.ref, 900000));
rec('P2 webhook amount larger than the top-up requested', (await bal(A.school)) - b0 > 1000, r.status + ' delta=' + ((await bal(A.school)) - b0));

// P3: same payment delivered 10x at the same time (provider retries)
b0 = await bal(A.school);
const t3 = await initiate(3000);
const body3 = paid(t3.ref, 3000);
await Promise.all(Array.from({ length: 10 }, () => hook(body3)));
rec('P3 concurrent duplicate webhooks credit more than once', (await bal(A.school)) - b0 > 3000, 'delta=' + ((await bal(A.school)) - b0) + ' (expected 3000)');

// P3b: one top-up reported twice under different provider IDs
// (e.g. NaJiki sends both payment.success and payment.completed)
b0 = await bal(A.school);
const t3b = await initiate(2200);
await hook(paid(t3b.ref, 2200, { paymentIntentId: crypto.randomUUID() }), { event: 'payment.success' });
await hook(paid(t3b.ref, 2200, { paymentIntentId: crypto.randomUUID() }), { event: 'payment.completed' });
rec('P3b one top-up credited twice (two provider notifications)', (await bal(A.school)) - b0 > 2200, 'delta=' + ((await bal(A.school)) - b0) + ' (expected 2200)');

// P4: 10 different payments land at once -> lost updates
b0 = await bal(A.school);
const t4 = [];
for (let i = 0; i < 10; i++) t4.push((await initiate(100 + i)).ref);
await Promise.all(t4.map((ref, i) => hook(paid(ref, 100 + i))));
const exp4 = Array.from({ length: 10 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0);
rec('P4 concurrent different payments lose money (lost update)', (await bal(A.school)) - b0 !== exp4, 'delta=' + ((await bal(A.school)) - b0) + ' (expected ' + exp4 + ')');

// P5: "payment.success" event whose status says FAILED
b0 = await bal(A.school);
const t5 = await initiate(1200);
r = await hook(paid(t5.ref, 1200, { status: 'failed' }), { event: 'payment.success' });
rec('P5 failed payment credited because event name says success', (await bal(A.school)) > b0, r.status + ' delta=' + ((await bal(A.school)) - b0));

// P6: payment in another currency credited as UGX
b0 = await bal(A.school);
const t6 = await initiate(1300);
r = await hook(paid(t6.ref, 1300, { currency: 'USD' }));
rec('P6 non-UGX payment credited as UGX', (await bal(A.school)) > b0, r.status + ' delta=' + ((await bal(A.school)) - b0));

// P7: school A's payment re-routed to school B
bB = await bal(B.school);
const t7 = await initiate(1400);
r = await hook(paid(t7.ref, 1400, { externalEntityId: B.school, metadata: { schoolId: B.school, idempotencyKey: t7.ref } }));
rec("P7 A's payment credited to another school", (await bal(B.school)) > bB, r.status + ' B delta=' + ((await bal(B.school)) - bB));

// P8: database hiccup while recording the payment -> app says "OK" to NaJiki,
// NaJiki stops retrying, and the school's money is never credited.
b0 = await bal(A.school);
const t8 = await initiate(777);
await q('ALTER TABLE public.transactions ADD CONSTRAINT lab_tx_fail CHECK (amount <> 777)');
r = await hook(paid(t8.ref, 777));
await q('ALTER TABLE public.transactions DROP CONSTRAINT lab_tx_fail');
const lost = r.status >= 200 && r.status < 300 && (await bal(A.school)) === b0;
rec('P8 DB error swallowed: provider told OK, payment never credited', lost, r.status + ' ' + r.text.slice(0, 90));
if (!lost) {
  // provider retries after the hiccup: must now credit exactly once
  r = await hook(paid(t8.ref, 777));
  legit('retry after DB hiccup credits once', (await bal(A.school)) - b0 === 777, r.status + ' delta=' + ((await bal(A.school)) - b0));
}

// P9: double-click on "Top up" for a school without a wallet -> duplicate wallets
await q('UPDATE public.wallets SET balance=0 WHERE tenant_id=$1 OR school_id=$1', [A.school]); await q('DELETE FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [A.school]);
await Promise.all(Array.from({ length: 5 }, () => act('topUpBalance', [500, '0772123456'])));
const nW = await wallets(A.school);
rec('P9 concurrent top-up clicks create duplicate wallets', nW > 1, 'wallets=' + nW);
// ...and with duplicates, does a real payment still show up on the dashboard?
const t9 = await initiate(2500);
const before9 = await act('getSchoolBalance', []);
r = await hook(paid(t9.ref, 2500));
const after9 = await act('getSchoolBalance', []);
const shown = (after9.value && after9.value.balance) - (before9.value && before9.value.balance);
rec('P9b paid top-up not visible on dashboard (wallet confusion)', shown !== 2500, 'dashboard delta=' + shown + ' wallets=' + (await wallets(A.school)));

// P10: the "process pending notifications" action fakes SMS delivery
const simAvailable = !!ids.processPendingNotificationsAction;
if (simAvailable) {
  await q("INSERT INTO school.notifications(school_id, recipient_type, channel, status, message) VALUES ($1,'parent','sms','pending','lab sim')", [A.school]);
  await act('processPendingNotificationsAction', []);
  const s = await q("SELECT status FROM school.notifications WHERE message='lab sim'");
  rec('P10 admin can mark queued SMS as delivered without sending', s[0] && s[0].status === 'sent', 'status=' + (s[0] && s[0].status));
} else {
  rec('P10 admin can mark queued SMS as delivered without sending', false, 'action not exposed in this build');
}

// P11: oversized unauthenticated webhook body is read fully
r = await hook(null, { auth: 'none', raw: 'x'.repeat(3 * 1024 * 1024) });
rec('P11 3MB unauthenticated webhook body accepted for processing', r.status !== 413, 'status=' + r.status);

// P12: the outbound API key (sent to NaJiki on every top-up, so known to anyone
// who can see those requests) also works as the webhook password
const apiKeySeen = t1.sent && t1.sent.headers.authorization.replace(/^Bearer\s+/i, '');
b0 = await bal(A.school);
const t12 = await initiate(1100);
r = await hook(paid(t12.ref, 1100), { secret: apiKeySeen });
rec('P12 outbound API key accepted as webhook secret', r.status === 200 && (await bal(A.school)) > b0,
  r.status + ' (webhook secret configured: ' + (process.env.NAJIKI_WEBHOOK_SECRET ? 'yes' : 'no') + ')');

// S1-S5: signature attacks against NaJiki's timestamped scheme. Each uses a
// fresh, genuinely started top-up so only the signature check stands in the way.
const sigAttack = async (name, amount, opts) => {
  const t = await initiate(amount);
  const before = await bal(A.school);
  const rr = await (opts.custom ? opts.custom(paid(t.ref, amount)) : hook(paid(t.ref, amount), opts));
  rec(name, (await bal(A.school)) > before, rr.status + ' delta=' + ((await bal(A.school)) - before));
};
await sigAttack('S1 captured webhook replayed after the 72h window', 1810, { at: Date.now() - 80 * 3600 * 1000 });
await sigAttack('S2 signed body altered (amount raised) in transit', 1820, { custom: async (d) => {
  const body = JSON.stringify(d); const h = najikiHeaders(SECRET, body);
  return hook(null, { auth: 'none', raw: body.replace('"amount":1820', '"amount":1821'), headersOverride: h });
} });
await sigAttack('S3 timestamp header swapped (signature for another time)', 1830, { custom: async (d) => {
  const body = JSON.stringify(d); const h = najikiHeaders(SECRET, body, Date.now() - 100 * 3600 * 1000);
  return hook(null, { auth: 'none', raw: body, headersOverride: { ...h, 'X-Najiki-Timestamp': String(Date.now()) } });
} });
await sigAttack('S4 legacy untimestamped body-HMAC accepted', 1840, { auth: 'hmac' });
await sigAttack('S5 raw secret in Authorization header accepted', 1850, { auth: 'bearer' });
await sigAttack('S6 signature from far in the future (pre-signed replay)', 1860, { at: Date.now() + 3600 * 1000 });

// legit: a signed payment we must refuse (4xx = NaJiki never retries) is still recorded
if (process.env.MIG05 !== '0') {
  const tc = await initiate(1900);
  const pc = paid(tc.ref, 1900, { externalEntityId: B.school });
  r = await hook(pc);
  const ev = await q("SELECT outcome FROM school.payment_events WHERE provider_ref=$1", [pc.paymentIntentId]);
  legit('refused payment notification is recorded for reconciliation', r.status === 400 && ev.some((e) => e.outcome === 'rejected_conflicting_school'), r.status + ' ' + JSON.stringify(ev));
}

// legit: delivery report reaches the SMS queue (school schema)
const nd = (await q("INSERT INTO school.notifications(school_id, recipient_type, channel, status, message) VALUES ($1,'parent','sms','pending','lab dlr') RETURNING id", [A.school]))[0].id;
r = await hook({ eventType: 'SMS_DELIVERY_UPDATE', smsId: nd, reference: 'SMS-REF-1', status: 'delivered', providerId: 'at_1', recipient: '+256700000000', applicationCode: 'school' });
const sd = (await q('SELECT status FROM school.notifications WHERE id=$1', [nd]))[0].status;
legit('NaJiki SMS_DELIVERY_UPDATE accepted, marks SMS sent', sd === 'sent', r.status + ' status=' + sd);
// legit: a payment.failed notification is acknowledged but credits nothing
b0 = await bal(A.school);
const tf = await initiate(1600);
r = await hook(paid(tf.ref, 1600, { status: 'failed', failureReason: 'User cancelled' }));
legit('payment.failed acknowledged, nothing credited', r.status === 200 && (await bal(A.school)) === b0, r.status + ' delta=' + ((await bal(A.school)) - b0));

const v = results.filter((x) => x.vulnerable).length;
console.log(`\n[${LABEL}] ${v} vulnerable / ${results.length} checks; legit failures: ${broken.length ? broken.join(', ') : 'none'}`);
fs.writeFileSync(`/home/user/mt-lab/payments-results-${LABEL}.json`, JSON.stringify({ vulnerable: v, total: results.length, broken, results }, null, 1));
await db.end();
