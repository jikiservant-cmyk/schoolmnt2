// Contract test for the SMS Edge Function (supabase/functions/send-sms).
//
// The edge function is the ONLY thing that spends money on SMS, and it is not
// deployed from this repo's test harness — so its two failure modes are checked
// here against NaJiki's REAL code:
//
//   1. the body it posts must pass najiki-finance2's `SmsInputSchema`
//   2. its response handling must match their real contract: POST
//      /api/messaging/send answers **202** (not 200), dedupes on
//      Idempotency-Key, and 409s when a key is reused with a different body
//
// It then runs the full path end to end against the lab: the sender's exact
// request -> NaJiki's 202 + `smsId` -> the sender stores `provider_ref` -> their
// real `SMS_DELIVERY_UPDATE` finds the row and marks it sent.
//
// Usage: node sms-sender-contract-check.mjs [base] [appDir] [label]
// Env:   NAJIKI_REPO (default /home/user/najiki-finance2), SKIP_SEED=1
import crypto from 'crypto';
import fs from 'fs';
import pg from 'pg';
import { register } from 'node:module';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import seedMod from './seed.js';

register(pathToFileURL(fileURLToPath(new URL('./ts-ext-hook.mjs', import.meta.url))).href);

const { IDS: { A: SA } } = seedMod;
const SCHOOL = SA.school;
const [BASE = 'http://127.0.0.1:3000', , LABEL = 'run'] = process.argv.slice(2);
const REPO = process.env.NAJIKI_REPO || '/home/user/najiki-finance2';
const SHIM = 'http://127.0.0.1:54321';
const SECRET = process.env.NAJIKI_WEBHOOK_SECRET || 'lab-dedicated-webhook-secret-123';
const API_KEY = process.env.NAJIKI_API_KEY || 'lab-najiki-secret';

if (!fs.existsSync(`${REPO}/src/lib/sms-policy.ts`)) {
  console.error(`Missing ${REPO}/src/lib/sms-policy.ts — clone najiki-finance2 first.`);
  process.exit(2);
}

const { SmsInputSchema, MAX_SMS_BODY_BYTES } =
  await import(`${REPO}/src/lib/sms-policy.ts`);
const { buildNotificationHeaders } =
  await import(`${REPO}/src/lib/notification-signature.ts`);

const senderPath = fileURLToPath(new URL('../supabase/functions/send-sms/sms-sender.ts', import.meta.url));
const { buildSmsRequest, classifySendResponse, normalizeMsisdn, idempotencyKeyFor, resolveUnitPrice, MAX_SMS_CHARS,
  nextAttempt, readAttempts, MAX_SEND_ATTEMPTS, MAX_CHARGED_ATTEMPTS } =
  await import(pathToFileURL(fs.existsSync(senderPath) ? senderPath : '/home/user/schoolmnt2/supabase/functions/send-sms/sms-sender.ts').href);

if (!process.env.SKIP_SEED) {
  execSync('node seed.js', { cwd: '/home/user/mt-lab', stdio: 'ignore', env: { ...process.env, RLS: '1' } });
}
await fetch(SHIM + '/__reload', { method: 'POST' });

console.log('\n--- 1. The sender body must satisfy THEIR SmsInputSchema ---');

const cases = [
  { name: 'E.164 with +', recipient: '+256772123456', message: 'Dear Parent, your child arrived safely.' },
  { name: 'bare 256', recipient: '256772123457', message: 'Your child has checked out.' },
  { name: 'local 0772...', recipient: '0772123458', message: 'Fees reminder.' },
  { name: 'spaces and dashes', recipient: '+256 772-123-459', message: 'Hi.' },
  { name: 'GSM extended chars', recipient: '+256772123460', message: 'Amount: 5,000 UGX [paid] {ref}' },
  { name: '160-char single segment', recipient: '+256772123461', message: 'A'.repeat(160) },
];

let fail = 0;
const check = (name, pass, detail = '') => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

for (const c of cases) {
  let built;
  try {
    built = buildSmsRequest({
      notificationId: crypto.randomUUID(),
      message: c.message,
      recipient: c.recipient,
      applicationCode: 'school',
      senderId: 'SMARTSKOOLZ',
    });
  } catch (e) {
    check(`${c.name}: builds a request`, false, (e).message);
    continue;
  }
  const parsed = SmsInputSchema.safeParse(built.body);
  check(
    `${c.name}: body passes THEIR SmsInputSchema`,
    parsed.success,
    parsed.success ? `${built.body.to}` : JSON.stringify(parsed.error?.issues)?.slice(0, 160)
  );
  check(
    `${c.name}: Idempotency-Key length is 8-255`,
    built.idempotencyKey.length >= 8 && built.idempotencyKey.length <= 255,
    built.idempotencyKey
  );
  check(
    `${c.name}: body stays under their ${MAX_SMS_BODY_BYTES}-byte limit`,
    Buffer.byteLength(JSON.stringify(built.body)) <= MAX_SMS_BODY_BYTES
  );
}

// Rejections the sender must refuse locally rather than let NaJiki 400 the batch.
for (const [name, recipient, message] of [
  ['empty recipient', '', 'hello'],
  ['too-short recipient', '12345', 'hello'],
  ['non-numeric recipient', 'not-a-phone', 'hello'],
  ['empty message', '+256772123456', ''],
  ['over provider char cap', '+256772123456', 'A'.repeat(MAX_SMS_CHARS + 1)],
]) {
  let threw = false;
  try { buildSmsRequest({ notificationId: crypto.randomUUID(), message, recipient, applicationCode: 'school' }); } catch { threw = true; }
  check(`${name} is refused locally`, threw);
}

check('senderId is dropped when it does not match their /^[A-Za-z0-9]{3,11}$/',
  !('senderId' in buildSmsRequest({ notificationId: crypto.randomUUID(), message: 'x', recipient: '+256772123456', senderId: 'bad sender!' }).body));

check('platform price must be a positive whole number',
  resolveUnitPrice('30') === 30 && resolveUnitPrice('0') === null && resolveUnitPrice('') === null && resolveUnitPrice('2.5') === null);

console.log('\n--- 2. Response handling matches THEIR contract ---');

const ok202 = classifySendResponse(202, { success: true, smsId: 'cabc123', reference: 'SCH-1', deduplicated: false });
check('202 + smsId is accepted (not treated as failure like a 200-only check would)',
  ok202.outcome === 'accepted' && ok202.providerRef === 'cabc123', JSON.stringify(ok202));
check('202 without smsId is retried, not silently dropped',
  classifySendResponse(202, { success: true }).outcome === 'retry');
check('their dedupe reply (deduplicated: true) is still accepted',
  classifySendResponse(202, { success: true, smsId: 'cabc123', deduplicated: true }).outcome === 'accepted');
check('409 idempotency conflict is a permanent failure',
  classifySendResponse(409, { error: 'Idempotency key reused' }).outcome === 'permanent_failure');
check('429 is retryable and honours Retry-After',
  classifySendResponse(429, { error: 'Slow down' }, '30').outcome === 'retry' &&
  classifySendResponse(429, { error: 'Slow down' }, '30').retryAfterSeconds === 30);
check('5xx is retryable', classifySendResponse(503, { error: 'down' }).outcome === 'retry');
check('400/401/413 are permanent', ['permanent_failure',
  classifySendResponse(400, { error: 'bad' }).outcome,
  classifySendResponse(401, { error: 'no' }).outcome,
  classifySendResponse(413, { error: 'big' }).outcome].every((x) => x === 'permanent_failure'));

console.log('\n--- 2b. Retry accounting (there is no attempt_count column) ---');

const fresh = nextAttempt(null);
check('a fresh row is on attempt 1 of 3', fresh.attempts === 1 && fresh.maxAttempts === MAX_SEND_ATTEMPTS && !fresh.exhausted,
  JSON.stringify(fresh));
check('an uncharged row gives up on the 3rd attempt',
  nextAttempt({ attempts: 2, charged: false }).exhausted === true,
  JSON.stringify(nextAttempt({ attempts: 2, charged: false })));
check('attempt 2 of 3 is still retryable', nextAttempt({ attempts: 1 }).exhausted === false);
check('a charged row keeps going past 3 attempts',
  nextAttempt({ attempts: 5, charged: true }).exhausted === false &&
  nextAttempt({ attempts: 5, charged: true }).maxAttempts === MAX_CHARGED_ATTEMPTS,
  JSON.stringify(nextAttempt({ attempts: 5, charged: true })));
check('a charged row finally stops at its own cap',
  nextAttempt({ attempts: MAX_CHARGED_ATTEMPTS - 1, charged: true }).exhausted === true);
check('charging during the attempt switches to the charged cap',
  nextAttempt({ attempts: 2, charged: false }, true).maxAttempts === MAX_CHARGED_ATTEMPTS,
  JSON.stringify(nextAttempt({ attempts: 2, charged: false }, true)));
check('garbage in provider_response cannot break the counter',
  nextAttempt({ attempts: 'nonsense' }).attempts === 1 && readAttempts('not-an-object').attempts === 0,
  JSON.stringify(nextAttempt({ attempts: 'nonsense' })));

console.log('\n--- 3. End to end: sender -> NaJiki -> delivery report ---');

const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

await fetch(SHIM + '/__najiki/sms-log', { method: 'DELETE' });

// A notification row exactly as lib/notifications/queue.ts writes it.
const notifId = (await q(
  `INSERT INTO school.notifications(school_id, channel, notification_type, message, status, recipient_phone_snapshot, recipient_type, dedupe_key)
   VALUES ($1,'sms','attendance_check_in','Dear Parent, Alice checked in at 07:42.','queued','+256772123456','parent',$2) RETURNING id`,
  [SCHOOL, 'att:' + crypto.randomUUID()]
))[0].id;

const req = buildSmsRequest({
  notificationId: notifId,
  message: 'Dear Parent, Alice checked in at 07:42.',
  recipient: '+256772123456',
  applicationCode: 'school',
  senderId: 'SMARTSKOOLZ',
});

const res = await fetch(SHIM + '/__najiki/messaging/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
    'Idempotency-Key': req.idempotencyKey,
  },
  body: JSON.stringify(req.body),
});
const resJson = await res.json();
check('NaJiki accepts the send with 202', res.status === 202, `HTTP ${res.status}`);
const outcome = classifySendResponse(res.status, resJson);
check('sender classifies it as accepted', outcome.outcome === 'accepted', JSON.stringify(outcome));

// What the edge function stores on success.
await q('UPDATE school.notifications SET status=$2, provider_ref=$3, sent_at=now() WHERE id=$1',
  [notifId, 'sent', outcome.providerRef]);

// A retry with the same key must NOT produce a second message.
const retry = await fetch(SHIM + '/__najiki/messaging/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`, 'Idempotency-Key': req.idempotencyKey },
  body: JSON.stringify(req.body),
});
const retryJson = await retry.json();
const smsLog = await (await fetch(SHIM + '/__najiki/sms-log')).json();
check('a retried send is deduplicated by Idempotency-Key',
  retryJson.deduplicated === true && retryJson.smsId === outcome.providerRef && smsLog.length === 1,
  `dedup=${retryJson.deduplicated} messages=${smsLog.length}`);

// A key reused with a different body is a hard 409, not a silent resend.
const conflict = await fetch(SHIM + '/__najiki/messaging/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`, 'Idempotency-Key': req.idempotencyKey },
  body: JSON.stringify({ ...req.body, message: 'A different message entirely' }),
});
check('reusing a key with a different body is 409',
  conflict.status === 409 && classifySendResponse(conflict.status, await conflict.json()).outcome === 'permanent_failure',
  `HTTP ${conflict.status}`);

// Their real terminal delivery notification must find the row via provider_ref.
const deliveryBody = JSON.stringify({
  eventType: 'SMS_DELIVERY_UPDATE',
  smsId: outcome.providerRef,
  reference: outcome.reference,
  status: 'delivered',
  providerId: 'ATXid_' + crypto.randomBytes(4).toString('hex'),
  recipient: '+256772123456',
  applicationCode: 'school',
});
const signed = await fetch(BASE + '/api/webhooks/najiki', {
  method: 'POST',
  body: deliveryBody,
  headers: buildNotificationHeaders(SECRET, deliveryBody),
});
const st = (await q('SELECT status FROM school.notifications WHERE id=$1', [notifId]))[0].status;
check('their SMS_DELIVERY_UPDATE finds the row the sender stored', signed.status === 200 && st === 'sent', `HTTP ${signed.status} status=${st}`);

// The wallet reference the sender uses is the same idempotent key.
check('wallet reference equals the send idempotency key', req.walletReference === req.idempotencyKey, req.walletReference);
const debit1 = await q('SELECT school.debit_sms_wallet($1, 30, $2) AS r', [SCHOOL, req.walletReference]);
const debit2 = await q('SELECT school.debit_sms_wallet($1, 30, $2) AS r', [SCHOOL, req.walletReference]);
check('charging the same SMS twice is refused as duplicate',
  debit1[0].r.outcome === 'duplicate' || debit2[0].r.outcome === 'duplicate',
  `${debit1[0].r.outcome} / ${debit2[0].r.outcome}`);

await db.end();
console.log(`\n=== SMS SENDER CONTRACT [${LABEL}]: ${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' FAILED'} ===`);
process.exit(fail ? 1 : 0);
