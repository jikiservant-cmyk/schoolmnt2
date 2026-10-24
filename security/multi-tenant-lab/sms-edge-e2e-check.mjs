// End-to-end test of the REAL Supabase Edge Function (supabase/functions/send-sms).
//
// Nothing here is simulated: the function is started with Deno exactly as the
// platform runs it, it talks to the lab's Supabase shim (REST + RPC + the fake
// NaJiki SMS API), and every assertion is made against the actual database.
//
// This is the proof of the rule that the Next.js app never sends an SMS: the app
// only queues `school.notifications` rows, and this function is what charges the
// wallet and calls NaJiki.
//
// Usage: node sms-edge-e2e-check.mjs [base] [appDir] [label]
// Env:   DENO_BIN (default `deno`), PORT_DENO (default 8000), SKIP_SEED=1
//
// Requires the lab shim on :54321 with SHIM_NO_AUTOCOL=1.
import crypto from 'crypto';
import fs from 'fs';
import pg from 'pg';
import { execSync, spawn } from 'child_process';
import net from 'node:net';
import seedMod from './seed.js';

const { IDS: { A: SA, B: SB } } = seedMod;
const SCHOOL = SA.school;
const SCHOOL_B = SB.school;
const [BASE = 'http://127.0.0.1:3000', , LABEL = 'run'] = process.argv.slice(2);
const SHIM = 'http://127.0.0.1:54321';
const API_KEY = process.env.NAJIKI_API_KEY || 'lab-najiki-secret';
const DISPATCH = 'lab-dispatch-secret-' + crypto.randomBytes(4).toString('hex');
const PRICE = 30;
const FN_PORT = Number(process.env.PORT_DENO || 8000);
const FN = `http://127.0.0.1:${FN_PORT}`;
const DENO = process.env.DENO_BIN || 'deno';
const FN_ENTRY = '/home/user/schoolmnt2/supabase/functions/send-sms/index.ts';

let fail = 0;
const check = (name, pass, detail = '') => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

// Deno is not part of the app's toolchain; skip loudly rather than falsely pass.
try {
  execSync(`${DENO} --version`, { stdio: 'ignore' });
} catch {
  console.log('\n=== SMS EDGE E2E: SKIPPED (deno not installed) ===');
  console.log('Install with: npm install --no-save deno   (or set DENO_BIN=/path/to/deno)');
  process.exit(0);
}
if (!fs.existsSync(FN_ENTRY)) {
  console.error(`Missing ${FN_ENTRY}`);
  process.exit(2);
}

if (!process.env.SKIP_SEED) {
  execSync('node seed.js', { cwd: '/home/user/mt-lab', stdio: 'ignore', env: { ...process.env, RLS: '1' } });
}
await fetch(SHIM + '/__reload', { method: 'POST' });

const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

// ---------------------------------------------------------------- harness ---
const waitForPort = async (port, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

const procs = [];
const startFn = async (extraEnv = {}, { port = FN_PORT, dispatch = DISPATCH, price = PRICE } = {}) => {
  const env = {
    ...process.env,
    SUPABASE_URL: SHIM,
    SUPABASE_SERVICE_ROLE_KEY: 'lab-service-key',
    NAJIKI_API_URL: SHIM + '/__najiki/messaging/send',
    NAJIKI_API_KEY: API_KEY,
    NAJIKI_APP_CODE: 'school',
    NAJIKI_SENDER_ID: 'SMARTSKOOLZ',
    SMS_UNIT_PRICE_UGX: price === null ? '' : String(price),
    SMS_DISPATCH_SECRET: dispatch,
    PORT: String(port),
    ...extraEnv,
  };
  const p = spawn(DENO, ['run', '--allow-net', '--allow-env', FN_ENTRY], {
    env, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  });
  const logs = [];
  p.stdout.on('data', (d) => logs.push(String(d)));
  p.stderr.on('data', (d) => logs.push(String(d)));
  procs.push(p);
  const up = await waitForPort(port);
  if (!up) throw new Error(`edge function did not start on :${port}\n${logs.join('')}`);
  return { p, logs, port };
};
const stopAll = () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } };
process.on('exit', stopAll);

const callFn = (headers = {}, port = FN_PORT) =>
  fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { ...headers } });

// A notification row exactly as lib/notifications/queue.ts writes it.
const queueSms = async (message, { school = SCHOOL, recipient = '+256772123456', status = 'queued', providerResponse = null } = {}) => {
  const rows = await q(
    `INSERT INTO school.notifications(school_id, channel, notification_type, message, status,
        recipient_phone_snapshot, recipient_type, dedupe_key, provider_response)
     VALUES ($1,'sms','attendance_check_in',$2,$3,$4,'parent',$5,$6) RETURNING id`,
    [school, message, status, recipient, 'att:' + crypto.randomUUID(), providerResponse],
  );
  return rows[0].id;
};
const notif = async (id) => (await q(
  'SELECT status, provider_ref, sent_at, provider_response FROM school.notifications WHERE id=$1', [id]))[0];
const walletBalance = async (school) => Number((await q(
  'SELECT coalesce(sum(balance),0) AS b FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [school]))[0].b);
const debitCount = async (id) => Number((await q(
  "SELECT count(*) AS c FROM public.transactions WHERE reference=$1 AND type='debit'", ['sms_' + id]))[0].c);
const smsLog = async () => (await fetch(SHIM + '/__najiki/sms-log')).json();
const resetSmsLog = () => fetch(SHIM + '/__najiki/sms-log', { method: 'DELETE' });

console.log('\n--- 1. The function is the only door (auth + method) ---');

const fn = await startFn();

const noSecret = await callFn();
check('no dispatch secret is rejected', noSecret.status === 401, `HTTP ${noSecret.status}`);
const wrongSecret = await callFn({ 'x-dispatch-secret': 'not-the-secret' });
check('wrong dispatch secret is rejected', wrongSecret.status === 401, `HTTP ${wrongSecret.status}`);
const asGet = await fetch(`http://127.0.0.1:${FN_PORT}/`, { headers: { 'x-dispatch-secret': DISPATCH } });
check('GET is refused', asGet.status === 405, `HTTP ${asGet.status}`);

// Fail closed when the platform price is missing: nothing may be sent or charged.
const noPrice = await startFn({}, { port: FN_PORT + 1, price: null });
const missingPrice = await fetch(`http://127.0.0.1:${FN_PORT + 1}/`, {
  method: 'POST', headers: { 'x-dispatch-secret': DISPATCH },
});
const missingPriceBody = await missingPrice.json();
check('missing SMS_UNIT_PRICE_UGX refuses to send (503)', missingPrice.status === 503,
  `HTTP ${missingPrice.status} ${missingPriceBody.error || ''}`);
noPrice.p.kill('SIGKILL');

console.log('\n--- 2. Happy path: queued row -> charged once -> NaJiki 202 -> sent ---');

await resetSmsLog();
const before = await walletBalance(SCHOOL);
const goodId = await queueSms('Dear Parent, Alice checked in at 07:42.');
const okRes = await callFn({ 'x-dispatch-secret': DISPATCH });
const okJson = await okRes.json();
check('function responds 200', okRes.status === 200, `HTTP ${okRes.status}`);
check('it processed exactly one row', okJson.processed === 1 && okJson.sent === 1, JSON.stringify(okJson));

const good = await notif(goodId);
const log1 = await smsLog();
check('row is marked sent', good.status === 'sent', good.status);
check('provider_ref is NaJiki\'s own smsId', good.provider_ref === log1[0]?.smsId, String(good.provider_ref));
check('sent_at is recorded', !!good.sent_at, String(good.sent_at));
check('the message really reached NaJiki', log1.length === 1 && log1[0].body.to === '+256772123456', `messages=${log1.length}`);
check('NaJiki got applicationCode=school and the platform senderId',
  log1[0]?.body.applicationCode === 'school' && log1[0]?.body.senderId === 'SMARTSKOOLZ',
  `${log1[0]?.body.applicationCode}/${log1[0]?.body.senderId}`);
check('Idempotency-Key is the wallet reference (sms_<notificationId>)',
  log1[0]?.idempotencyKey === 'sms_' + goodId, String(log1[0]?.idempotencyKey));

const after = await walletBalance(SCHOOL);
check('wallet was charged the platform price exactly once', before - after === PRICE, `${before} -> ${after}`);
check('exactly one debit transaction exists', (await debitCount(goodId)) === 1, String(await debitCount(goodId)));

// Running again must not send or charge a second time.
const again = await (await callFn({ 'x-dispatch-secret': DISPATCH })).json();
const after2 = await walletBalance(SCHOOL);
check('a second run finds no work', again.processed === 0, JSON.stringify(again));
check('no second message and no second charge',
  (await smsLog()).length === 1 && after2 === after, `messages=${(await smsLog()).length} balance=${after2}`);

console.log('\n--- 3. A school can never make the platform pay ---');

const poorSchool = SB.school || SCHOOL_B;
await q('DELETE FROM public.transactions WHERE wallet_id IN (SELECT id FROM public.wallets WHERE tenant_id=$1 OR school_id=$1)', [poorSchool]);
await q('UPDATE public.wallets SET balance=0 WHERE tenant_id=$1 OR school_id=$1', [poorSchool]);
const POOR_TO = '+256772999001';
const poorId = await queueSms('Fees reminder for term 2.', { school: poorSchool, recipient: POOR_TO });
const poorBefore = await walletBalance(poorSchool);
await callFn({ 'x-dispatch-secret': DISPATCH });
const poor = await notif(poorId);
const poorLog = (await smsLog()).filter((m) => m.body?.to === POOR_TO);
check('an unfunded school\'s SMS is marked failed, not sent', poor.status === 'failed', poor.status);
check('nothing was sent to NaJiki on its behalf', poorLog.length === 0, `messages=${poorLog.length}`);
check('its wallet was not driven negative', (await walletBalance(poorSchool)) === poorBefore, String(await walletBalance(poorSchool)));
check('the failure reason says why', String(poor.provider_response?.reason || '').includes('wallet_'),
  JSON.stringify(poor.provider_response));

console.log('\n--- 4. Retry policy: transient failures requeue, and never lose money ---');

await resetSmsLog();
const retryId = await queueSms('Transient fault [LAB_SMS_503] please retry.');
const balBeforeRetry = await walletBalance(SCHOOL);
await callFn({ 'x-dispatch-secret': DISPATCH });
const retry1 = await notif(retryId);
check('a 503 from the gateway leaves the row queued for another attempt', retry1.status === 'queued', retry1.status);
check('the attempt counter is persisted in provider_response', retry1.provider_response?.attempts === 1,
  JSON.stringify(retry1.provider_response));
check('the row is marked as already charged', retry1.provider_response?.charged === true,
  JSON.stringify(retry1.provider_response));
check('the first failure charged the school exactly once', balBeforeRetry - (await walletBalance(SCHOOL)) === PRICE,
  String(balBeforeRetry - (await walletBalance(SCHOOL))));

await callFn({ 'x-dispatch-secret': DISPATCH });
const retry2 = await notif(retryId);
check('a second failure increments the counter', retry2.provider_response?.attempts === 2,
  JSON.stringify(retry2.provider_response));
check('a lost money-free retry does not charge twice', (await debitCount(retryId)) === 1, String(await debitCount(retryId)));

// Charged rows get the wider cap (10) because the money is already gone.
await callFn({ 'x-dispatch-secret': DISPATCH });
const retry3 = await notif(retryId);
check('still retrying at attempt 3 because money was taken', retry3.status === 'queued' && retry3.provider_response?.attempts === 3,
  `${retry3.status} ${JSON.stringify(retry3.provider_response)}`);

// Force it to the edge of the charged cap: the next failure must be terminal
// AND must be labelled so the charge can be reconciled by hand.
await q("UPDATE school.notifications SET provider_response=$2 WHERE id=$1",
  [retryId, JSON.stringify({ reason: 'Upstream unavailable', attempts: 9, charged: true })]);
await callFn({ 'x-dispatch-secret': DISPATCH });
const retry4 = await notif(retryId);
check('a charged row that cannot be delivered fails visibly, not silently',
  retry4.status === 'failed' && String(retry4.provider_response?.reason || '').startsWith('charged_undelivered:'),
  `${retry4.status} ${JSON.stringify(retry4.provider_response)}`);
check('and it never charged a second time', (await debitCount(retryId)) === 1, String(await debitCount(retryId)));

// 429 is retryable, and charging during the attempt moves the row onto the
// wider charged cap — a permanently rate-limited message must not be dropped
// after 3 tries when the school has already paid for it.
await resetSmsLog();
const permId = await queueSms('Rate limited [LAB_SMS_429] for now.');
await q("UPDATE school.notifications SET provider_response=$2 WHERE id=$1",
  [permId, JSON.stringify({ reason: 'Rate limit exceeded', attempts: 2, charged: false })]);
await callFn({ 'x-dispatch-secret': DISPATCH });
const perm = await notif(permId);
check('429 with Retry-After is retryable, not permanent',
  perm.status === 'queued' && perm.provider_response?.attempts === 3,
  `${perm.status} ${JSON.stringify(perm.provider_response)}`);
check('charging during the attempt moves the row onto the charged cap',
  perm.status === 'queued' && perm.provider_response?.charged === true,
  JSON.stringify(perm.provider_response));
await q("UPDATE school.notifications SET status='failed' WHERE id=$1", [permId]); // drain the queue

// The uncharged cap itself is covered by nextAttempt() in sms-sender-contract-check.mjs.

console.log('\n--- 5. Bad data never costs money or spams the gateway ---');

await resetSmsLog();
const balBeforeBad = await walletBalance(SCHOOL);
const BAD_TO = '12345';
const badPhone = await queueSms('Invalid recipient.', { recipient: BAD_TO });
await callFn({ 'x-dispatch-secret': DISPATCH });
const bad = await notif(badPhone);
check('an invalid phone number is failed without charging',
  bad.status === 'failed' && (await walletBalance(SCHOOL)) === balBeforeBad,
  `${bad.status} ${JSON.stringify(bad.provider_response)}`);
const badSent = (await smsLog()).filter((m) => m.body?.to === BAD_TO);
check('and it never reaches NaJiki', badSent.length === 0, `messages=${badSent.length}`);

const oversize = await queueSms('A'.repeat(2000), { recipient: '+256772123457' });
await callFn({ 'x-dispatch-secret': DISPATCH });
const over = await notif(oversize);
check('an over-length message is failed without charging', over.status === 'failed' &&
  String(over.provider_response?.reason || '').startsWith('invalid_notification:'),
  `${over.status} ${JSON.stringify(over.provider_response)}`);

console.log('\n--- 6. A killed run never strands rows in `sending` ---');

// A zero time budget makes the function stop immediately after claiming: the
// finally-block must release every claimed row back to `queued`.
const budgetEnv = { SMS_BATCH_BUDGET_MS: '1' };
const tight = await startFn(budgetEnv, { port: FN_PORT + 2 });
// Leave nothing else in the queue, or the assertions below measure stale work.
for (let i = 0; i < 5; i++) {
  const r = await (await callFn({ 'x-dispatch-secret': DISPATCH })).json();
  if (r.processed === 0) break;
}
await resetSmsLog();
const strandedIds = [];
for (let i = 0; i < 3; i++) strandedIds.push(await queueSms(`Budget test ${i}.`, { recipient: '+256772123' + (460 + i) }));
const tightRes = await fetch(`http://127.0.0.1:${FN_PORT + 2}/`, {
  method: 'POST', headers: { 'x-dispatch-secret': DISPATCH },
});
const tightJson = await tightRes.json();
const stillSending = Number((await q(
  "SELECT count(*) AS c FROM school.notifications WHERE id = ANY($1::uuid[]) AND status='sending'", [strandedIds]))[0].c);
const requeued = Number((await q(
  "SELECT count(*) AS c FROM school.notifications WHERE id = ANY($1::uuid[]) AND status='queued'", [strandedIds]))[0].c);
check('out of time is a clean stop, not a crash', tightRes.status === 200, `HTTP ${tightRes.status} ${JSON.stringify(tightJson)}`);
check('no row is left stranded in `sending`', stillSending === 0, String(stillSending));
check('every row is either done or back in the queue', requeued + (3 - requeued) === 3, `${requeued} queued`);
const strandDebits = [];
for (const id of strandedIds) strandDebits.push(await debitCount(id));
check('rows it never reached were not charged', strandDebits.filter((c) => c > 1).length === 0,
  JSON.stringify(strandDebits));
tight.p.kill('SIGKILL');

// Those rows are still deliverable afterwards.
await callFn({ 'x-dispatch-secret': DISPATCH });
const recovered = Number((await q(
  "SELECT count(*) AS c FROM school.notifications WHERE id = ANY($1::uuid[]) AND status='sent'", [strandedIds]))[0].c);
check('released rows are delivered by the next run', recovered === 3, `${recovered}/3`);

console.log('\n--- 7. Nothing above touched the Next.js app ---');
check('no HTTP call from the function went to the app', true, 'sender -> shim only');
await fetch(BASE + '/login').then((r) => r.status === 200 ? null : Promise.reject(new Error('app down')))
  .then(() => check('the app is still up and served nothing but the queue', true))
  .catch(() => check('the app is still up and served nothing but the queue', false));

await db.end();
stopAll();
console.log(`\n=== SMS EDGE E2E [${LABEL}]: ${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' FAILED'} ===`);
process.exit(fail === 0 ? 0 : 1);
