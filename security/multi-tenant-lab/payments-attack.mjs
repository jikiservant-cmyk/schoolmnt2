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

// Webhook as NaJiki would send it (authenticated with the configured secret).
const hook = async (data, { event = 'payment.success', auth = 'bearer', secret = SECRET, raw } = {}) => {
  const body = raw ?? JSON.stringify({ event, data });
  const headers = { 'content-type': 'application/json' };
  if (auth === 'bearer') headers.authorization = 'Bearer ' + secret;
  if (auth === 'hmac') headers['x-najiki-signature'] = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const r = await fetch(BASE + '/api/webhooks/najiki', { method: 'POST', headers, body });
  return { status: r.status, text: (await r.text()).slice(0, 200) };
};
// School A's admin starts a real top-up through the app; returns the reference sent to NaJiki.
const initiate = async (amount) => {
  await fetch(SHIM + '/__najiki/log', { method: 'DELETE' });
  const r = await act('topUpBalance', [amount, '0772123456']);
  const log = await (await fetch(SHIM + '/__najiki/log')).json();
  const last = log[log.length - 1];
  return { ok: !!(r.value && r.value.success), ref: last && last.body.reference, sent: last, value: r.value };
};
const paid = (ref, amount, extra = {}) => ({ status: 'SUCCESS', amount, currency: 'UGX', transactionId: 'nj_' + crypto.randomUUID(),
  reference: ref, metadata: { schoolId: A.school, idempotencyKey: ref, amount }, ...extra });

// ---------- legit flow (must keep working) ----------
let b0 = await bal(A.school);
const t1 = await initiate(2000);
legit('top-up request reaches NaJiki with school + reference', t1.ok && t1.ref && t1.sent.body.schoolId === A.school, JSON.stringify(t1.value).slice(0, 120));
const body1 = paid(t1.ref, 2000);
let r = await hook(body1);
legit('paid webhook credits exactly the amount', r.status === 200 && (await bal(A.school)) - b0 === 2000, r.status + ' delta=' + ((await bal(A.school)) - b0));
b0 = await bal(A.school);
r = await hook(body1);
legit('same webhook again is accepted but not credited twice', r.status === 200 && (await bal(A.school)) === b0, r.status + ' delta=' + ((await bal(A.school)) - b0));
b0 = await bal(A.school);
const t1h = await initiate(1500);
const hb = JSON.stringify({ event: 'payment.success', data: paid(t1h.ref, 1500) });
r = await hook(null, { auth: 'hmac', raw: hb });
legit('HMAC-signed webhook credits', r.status === 200 && (await bal(A.school)) - b0 === 1500, r.status + ' delta=' + ((await bal(A.school)) - b0));
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
await hook(paid(t3b.ref, 2200), { event: 'payment.success' });
await hook(paid(t3b.ref, 2200), { event: 'payment.completed' });
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
r = await hook(paid(t5.ref, 1200, { status: 'FAILED' }));
rec('P5 failed payment credited because event name says success', (await bal(A.school)) > b0, r.status + ' delta=' + ((await bal(A.school)) - b0));

// P6: payment in another currency credited as UGX
b0 = await bal(A.school);
const t6 = await initiate(1300);
r = await hook(paid(t6.ref, 1300, { currency: 'USD' }));
rec('P6 non-UGX payment credited as UGX', (await bal(A.school)) > b0, r.status + ' delta=' + ((await bal(A.school)) - b0));

// P7: school A's payment re-routed to school B
bB = await bal(B.school);
const t7 = await initiate(1400);
r = await hook(paid(t7.ref, 1400, { metadata: { schoolId: B.school, idempotencyKey: t7.ref } }));
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
await q('DELETE FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [A.school]);
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

// legit: delivery report reaches the SMS queue (school schema)
const nd = (await q("INSERT INTO school.notifications(school_id, recipient_type, channel, status, message) VALUES ($1,'parent','sms','pending','lab dlr') RETURNING id", [A.school]))[0].id;
r = await hook({ messageId: nd, status: 'DELIVERED' }, { event: 'message.status' });
const sd = (await q('SELECT status FROM school.notifications WHERE id=$1', [nd]))[0].status;
legit('delivery report marks the queued SMS as sent', sd === 'sent', r.status + ' status=' + sd);
// legit: a payment.failed notification is acknowledged but credits nothing
b0 = await bal(A.school);
const tf = await initiate(1600);
r = await hook(paid(tf.ref, 1600, { status: 'FAILED' }), { event: 'payment.failed' });
legit('payment.failed acknowledged, nothing credited', r.status === 200 && (await bal(A.school)) === b0, r.status + ' delta=' + ((await bal(A.school)) - b0));

const v = results.filter((x) => x.vulnerable).length;
console.log(`\n[${LABEL}] ${v} vulnerable / ${results.length} checks; legit failures: ${broken.length ? broken.join(', ') : 'none'}`);
fs.writeFileSync(`/home/user/mt-lab/payments-results-${LABEL}.json`, JSON.stringify({ vulnerable: v, total: results.length, broken, results }, null, 1));
await db.end();
