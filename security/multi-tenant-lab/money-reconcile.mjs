// Money reconciliation: real-life payment scenarios through the real app, then
// an audit that every shilling in the wallet is explained by exactly one payment.
// Usage: node money-reconcile.mjs <base> <appDir>      (re-seeds the DB; honours RLS=1)
import pg from 'pg';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { setupUsers, sessionCookie, actionIds, callAction, SHIM } from './lib.mjs';
import seedMod from './seed.js';
const { IDS: { A: SA, B: SB } } = seedMod;
const A = SA.school, B = SB.school;
const [BASE = 'http://127.0.0.1:3201', APPDIR = '/home/user/schoolmnt2'] = process.argv.slice(2);
const SECRET = process.env.NAJIKI_WEBHOOK_SECRET || 'lab-dedicated-webhook-secret-123';

execSync('node seed.js', { cwd: '/home/user/mt-lab' });
await fetch(SHIM + '/__reload', { method: 'POST' });
await setupUsers();
const ids = actionIds(APPDIR);
const cookies = { A: await sessionCookie('adminA@lab.io'), B: await sessionCookie('adminB@lab.io') };
const act = (who, n, args) => { const a = ids[n][0]; return callAction(BASE, '/' + a.page.replace(/^app\//, '').replace(/\/page$/, ''), a.id, args, cookies[who]); };
const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
const bal = async (school) => Number((await q('SELECT coalesce(sum(balance),0) b FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [school]))[0].b);

let failures = 0;
const check = (name, pass, detail = '') => { if (!pass) failures++; console.log(`${pass ? 'OK    ' : 'FAILED'} ${name}${detail ? '  [' + detail + ']' : ''}`); };

// NaJiki's signer (najiki-finance2 notification-signature.ts) and payload shape.
const send = async (payload, at = Date.now()) => {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(`${at}.${body}`).digest('hex');
  const r = await fetch(BASE + '/api/webhooks/najiki', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Najiki-Notification': 'true', 'X-Najiki-Timestamp': String(at), 'X-Najiki-Signature': `t=${at},v=${sig}` } });
  return { status: r.status, body: await r.text(), payload, at };
};
const initiate = async (who, amount, phone = '0772123456') => {
  await fetch(SHIM + '/__najiki/log', { method: 'DELETE' });
  const t0 = Date.now();
  const r = await act(who, 'topUpBalance', [amount, phone]);
  const log = await (await fetch(SHIM + '/__najiki/log')).json();
  const last = log[log.length - 1];
  return { ok: !!r.value?.success, value: r.value, ms: Date.now() - t0, ref: last?.body?.idempotencyKey, school: last?.body?.externalEntityId, metadata: last?.body?.metadata, nj: last?.response };
};
// Payment-completed notification as NaJiki builds it.
const paid = (t, { amount = t.metadata.amount, status = 'success', echo = true, providerPaymentId = 'lp_' + crypto.randomUUID() } = {}) => ({
  ...(echo ? { paymentIntentId: t.nj?.paymentId ?? crypto.randomUUID() } : {}),
  reference: t.nj?.reference ?? 'SCHOOL-PAY-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
  status, amount, currency: 'UGX', providerPaymentId,
  failureReason: status === 'failed' ? 'User cancelled' : null,
  externalEntityId: t.school,
  ...(echo ? { metadata: t.metadata } : {}),
});

const startA = await bal(A), startB = await bal(B);
let expectedA = 0;
console.log(`start: school A ${startA} UGX, school B ${startB} UGX\n`);

// S1 normal top-up
const t1 = await initiate('A', 2000);
const s1 = await send(paid(t1));
expectedA += 2000;
check('S1 normal 2,000 top-up credited exactly once', t1.ok && s1.status === 200 && (await bal(A)) === startA + expectedA, `${s1.status} balance ${await bal(A)}`);

// S2 the same notification delivered 25 times at once
const t2 = await initiate('A', 3000);
const p2 = paid(t2);
const s2 = await Promise.all(Array.from({ length: 25 }, () => send(p2)));
expectedA += 3000;
check('S2 same payment delivered 25x in parallel -> credited once', (await bal(A)) === startA + expectedA, `statuses ${[...new Set(s2.map((r) => r.status))].join(',')} balance ${await bal(A)}`);

// S3 QStash retry 47 h later with the ORIGINAL signature
const s3 = await send(s1.payload, s1.at - 47 * 3600 * 1000);
check('S3 retry 47h later (original signature) -> no second credit', s3.status === 200 && (await bal(A)) === startA + expectedA, `${s3.status} ${s3.body.slice(0, 60)}`);

// S4 "failed" first, then the real success
const t4 = await initiate('A', 1500);
const s4a = await send(paid(t4, { status: 'failed' }));
const mid4 = await bal(A);
const s4b = await send(paid(t4));
expectedA += 1500;
check('S4 failed notice credits nothing, later success credits 1,500', s4a.status === 200 && mid4 === startA + expectedA - 1500 && s4b.status === 200 && (await bal(A)) === startA + expectedA, `${s4a.status}/${s4b.status}`);

// S5 a "failed" notice AFTER success must not credit or break anything
const s5 = await send({ ...s1.payload, status: 'failed', failureReason: 'late notice' });
check('S5 late "failed" after success -> balance unchanged', s5.status === 200 && (await bal(A)) === startA + expectedA, `${s5.status}`);

// S6 provider reports more than the school asked for
const t6 = await initiate('A', 2500);
const s6 = await send(paid(t6, { amount: 9999 }));
expectedA += 2500;
check('S6 report says 9,999 for a 2,500 top-up -> only 2,500 credited', (await bal(A)) === startA + expectedA, `${s6.status} balance ${await bal(A)}`);

// S7 partial payment
const t7 = await initiate('A', 4000);
const s7 = await send(paid(t7, { amount: 3000 }));
expectedA += 3000;
const s7b = await send(paid(t7, { amount: 1000 }));
check('S7 only 3,000 of 4,000 paid -> 3,000 credited; a 2nd notice for the same top-up adds nothing', (await bal(A)) === startA + expectedA, `${s7.status}/${s7b.status} balance ${await bal(A)}`);

// S8 notifications that lost our reference (no metadata / paymentIntentId):
// matched to the oldest pending top-up of the same amount; a RETRY of one
// must not grab the next pending top-up.
const t8a = await initiate('A', 1200), t8b = await initiate('A', 1200);
const p8 = paid(t8a, { echo: false });
const s8a = await send(p8);
expectedA += 1200;
const afterFirst = await bal(A);
const s8retry = await send(p8);
const afterRetry = await bal(A);
check('S8 reference-less payment credited once', s8a.status === 200 && afterFirst === startA + expectedA, `${s8a.status} ${s8a.body.slice(0, 50)}`);
check('S8 RETRY of that same reference-less payment does not credit the other pending top-up', afterRetry === afterFirst, `${s8retry.status} ${s8retry.body.slice(0, 60)} balance ${afterFirst} -> ${afterRetry}`);
expectedA += afterRetry - afterFirst; // keep the audit below consistent either way
const s8b = await send(paid(t8b, { echo: false }));
expectedA += (s8b.status === 200 && s8b.body.includes('credited')) ? 1200 : 0;

// S9 ten different payments arriving at the same moment
const t9 = [];
for (let i = 0; i < 10; i++) t9.push(await initiate('A', 500));
await Promise.all(t9.map((t) => send(paid(t))));
expectedA += 5000;
check('S9 10 different 500 payments at once -> exactly +5,000', (await bal(A)) === startA + expectedA, `balance ${await bal(A)}`);

// S10 school B's payment that claims to be for school A
const t10 = await initiate('B', 800);
const s10 = await send({ ...paid(t10), externalEntityId: A, metadata: { ...t10.metadata, schoolId: A } });
check("S10 school B's payment relabelled as school A -> nobody credited", (await bal(A)) === startA + expectedA && (await bal(B)) === startB, `${s10.status} ${s10.body.slice(0, 60)}`);

// S11 NaJiki errors (502) after the PIN prompt may have gone out, parent pays anyway
const t11 = await initiate('A', 700, '0772000500');
const s11 = await send(paid(t11));
expectedA += 700;
check('S11 NaJiki error on start: school told it failed', !t11.ok && /error|status|try/i.test(JSON.stringify(t11.value)), JSON.stringify(t11.value).slice(0, 80));
check('S11 ...parent paid anyway -> money still credited, not lost', s11.status === 200 && (await bal(A)) === startA + expectedA, `${s11.status} ${s11.body.slice(0, 60)}`);

// S12 NaJiki hangs: how long does the school's "Top up" button spin?
const t12 = await initiate('A', 600, '0772000999');
check('S12 NaJiki hangs: school gets a clear answer within 25 s', t12.ms < 25000 && /PIN prompt/.test(JSON.stringify(t12.value)), `${(t12.ms / 1000).toFixed(1)} s, answer: ${JSON.stringify(t12.value).slice(0, 90)}`);
const s12 = await send(paid(t12));
expectedA += 600;
check('S12 ...parent paid during the hang -> money still credited', s12.status === 200 && (await bal(A)) === startA + expectedA, `${s12.status}`);

// The dashboard shows the same number as the wallet
const shown = await act('A', 'getSchoolBalance', []);
check('dashboard balance = wallet balance', Number(shown.value?.balance) === (await bal(A)), `shown ${shown.value?.balance}, wallet ${await bal(A)}`);

// ---------------- AUDIT: do the books add up? ----------------
console.log('\n--- audit ---');
const endA = await bal(A);
check('school A: wallet grew by exactly the expected amount', endA - startA === expectedA, `grew ${endA - startA}, expected ${expectedA}`);
check('school B: wallet untouched', (await bal(B)) === startB, `${await bal(B)}`);
const ledger = Number((await q(`SELECT coalesce(sum(t.amount),0) s FROM public.transactions t JOIN public.wallets w ON w.id=t.wallet_id WHERE (w.tenant_id=$1 OR w.school_id=$1) AND t.type='credit' AND t.reference LIKE 'sch_topup_%'`, [A]))[0].s);
check('ledger: sum of credit rows = wallet growth', ledger === endA - startA, `ledger ${ledger}, growth ${endA - startA}`);
const events = Number((await q(`SELECT coalesce(sum(credited_amount),0) s FROM school.payment_events WHERE school_id=$1 AND outcome='credited'`, [A]))[0].s);
check('payment log: sum of "credited" events = wallet growth', events === endA - startA, `events ${events}`);
const dupRefs = await q(`SELECT reference, count(*) n FROM public.transactions GROUP BY reference HAVING count(*) > 1`);
check('no payment reference in the ledger twice', dupRefs.length === 0, dupRefs.map((d) => d.reference).join(','));
const orphan = await q(`SELECT e.idempotency_key FROM school.payment_events e LEFT JOIN public.transactions t ON t.reference=e.idempotency_key AND t.amount=e.credited_amount WHERE e.outcome='credited' AND t.id IS NULL`);
check('every "credited" event has its matching ledger row (same amount)', orphan.length === 0, orphan.map((o) => o.idempotency_key).join(','));
const over = await q(`SELECT reference FROM school.payment_intents WHERE credited_amount > amount`);
check('no top-up credited more than requested', over.length === 0, over.map((o) => o.reference).join(','));
const ci = Number((await q(`SELECT count(*) n FROM school.payment_intents WHERE school_id=$1 AND status='credited'`, [A]))[0].n);
const ce = Number((await q(`SELECT count(*) n FROM school.payment_events WHERE school_id=$1 AND outcome='credited'`, [A]))[0].n);
check('credited top-ups = credited events (one each)', ci === ce, `${ci} vs ${ce}`);
const mirror = (await q(`SELECT (settings->>'balance')::numeric b FROM school.schools WHERE id=$1`, [A]))[0].b;
check('legacy settings.balance mirror = wallet', Number(mirror) === endA, `${mirror} vs ${endA}`);
const held = await q(`SELECT outcome, count(*) n FROM school.payment_events WHERE outcome NOT IN ('credited','duplicate') GROUP BY outcome ORDER BY outcome`);
console.log('held for review (not credited, kept on record): ' + (held.map((h) => `${h.outcome}=${h.n}`).join(', ') || 'none'));

await db.end();
console.log(failures ? `\n${failures} FAILED` : '\nBOOKS BALANCE: ALL MONEY CHECKS OK');
process.exit(failures ? 1 : 0);
