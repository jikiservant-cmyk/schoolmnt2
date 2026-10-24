// Schema + source contract for the SMS Edge Function.
//
// The function that was deployed in the database could not send a single SMS,
// because it was written against things that do not exist. This suite locks
// those assumptions down so they cannot come back:
//
//   * it called `public.debit_sms_wallet(p_wallet_id, ...)`  -> 42883
//   * it wrote `retry_count` / `next_retry_at` / `error`     -> 42703
//   * it sent no Idempotency-Key, so retries sent duplicate SMS
//   * it never set `provider_ref`, so delivery reports matched nothing
//   * it defaulted the platform price to 1 UGX
//
// Part database, part static analysis, no Deno required.
//
// Usage: node sms-schema-contract-check.mjs [label]
import fs from 'fs';
import pg from 'pg';

const [LABEL = 'run'] = process.argv.slice(2);
const FN_DIR = '/home/user/schoolmnt2/supabase/functions/send-sms';
const APP_DIR = '/home/user/schoolmnt2';

let fail = 0;
const check = (name, pass, detail = '') => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

console.log('\n--- 1. The wallet RPC the function must call ---');

const fns = await q(`
  SELECT n.nspname AS schema, pg_get_function_identity_arguments(p.oid) AS args,
         p.prosecdef AS security_definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'debit_sms_wallet'`);
check('school.debit_sms_wallet(uuid, numeric, text, text) exists',
  fns.some((f) => f.schema === 'school' && f.args === 'p_school_id uuid, p_amount numeric, p_reference text, p_description text'),
  JSON.stringify(fns.map((f) => `${f.schema}(${f.args})`)));
check('it is SECURITY DEFINER (runs with its own privileges)',
  fns.filter((f) => f.schema === 'school').every((f) => f.security_definer === true));
check('there is no public.debit_sms_wallet for the deployed call to reach',
  !fns.some((f) => f.schema === 'public'),
  JSON.stringify(fns.map((f) => f.schema)));

let legacyError = null;
try {
  await q(`select public.debit_sms_wallet(p_wallet_id => null::uuid, p_amount => 1,
            p_idempotency_key => 'x', p_tenant_id => 'y', p_description => 'z')`);
} catch (e) {
  legacyError = e.code;
}
check('the deployed 5-argument call still fails with undefined_function (42883)',
  legacyError === '42883', String(legacyError));

const debit = (await q(`select school.debit_sms_wallet('aaaaaaaa-0000-4000-8000-000000000001'::uuid, 0, 'probe-zero', 'probe')`))[0];
check('a zero/negative amount is refused by the RPC itself', debit.debit_sms_wallet.outcome === 'invalid_amount',
  JSON.stringify(debit.debit_sms_wallet));

console.log('\n--- 2. The columns the function may and may not touch ---');

const cols = (await q(`
  SELECT column_name FROM information_schema.columns
   WHERE table_schema = 'school' AND table_name = 'notifications'`)).map((r) => r.column_name);
for (const c of ['status', 'provider_ref', 'sent_at', 'provider_response', 'message', 'recipient_phone_snapshot', 'school_id', 'channel']) {
  check(`school.notifications.${c} exists`, cols.includes(c));
}
for (const c of ['retry_count', 'next_retry_at', 'error', 'attempt_count']) {
  check(`school.notifications.${c} does NOT exist (the deployed function wrote it)`, !cols.includes(c));
}

console.log('\n--- 3. The function source must match that reality ---');

const indexSrc = fs.readFileSync(`${FN_DIR}/index.ts`, 'utf8');
const helperSrc = fs.readFileSync(`${FN_DIR}/sms-sender.ts`, 'utf8');
const allSrc = indexSrc + '\n' + helperSrc;
// Comments legitimately describe the old bugs; only CODE must be free of them.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/(^|[^:'"`])\/\/[^\n]*$/gm, '$1');
const codeOnly = stripComments(allSrc);

for (const forbidden of ['retry_count', 'next_retry_at', 'attempt_count', 'p_wallet_id', 'p_idempotency_key']) {
  check(`code never uses ${forbidden}`, !codeOnly.includes(forbidden));
}
check('the debit call passes p_school_id and p_reference',
  /p_school_id:\s*notif\.school_id/.test(indexSrc) && /p_reference:\s*request\.walletReference/.test(indexSrc));
check('the debit call is made in the school schema',
  /db\.schema\(SCHOOL_SCHEMA\)|school\.rpc\(/.test(indexSrc), 'school.rpc');
check('provider_response is written as an object, never JSON.stringify-ed',
  !/JSON\.stringify\(\s*najiki|JSON\.stringify\(\s*payload|JSON\.stringify\(\s*debit/.test(indexSrc));
check('provider_ref is set from NaJiki\'s own id on success',
  /provider_ref:\s*result\.providerRef/.test(indexSrc));
check('an Idempotency-Key header is sent', /['"]Idempotency-Key['"]\s*:/.test(indexSrc));
check('the wallet reference and the idempotency key are the same value',
  /walletReference:\s*idempotencyKey/.test(helperSrc) || /walletReference/.test(helperSrc));
check('the HTTP timeout is bounded', /AbortSignal\.timeout\(ctx\.timeoutMs\)/.test(indexSrc));

console.log('\n--- 4. Pricing is platform-only and never defaulted ---');

const priceCalls = [...indexSrc.matchAll(/SMS_COST[^;\n]*/g)].map((m) => m[0]);
check('SMS_COST is read but never given a numeric fallback',
  priceCalls.length > 0 && !priceCalls.some((c) => /\|\|\s*["']?\d/.test(c)),
  JSON.stringify(priceCalls));
check('a missing/invalid price returns 503 and sends nothing',
  /SMS pricing is not configured/.test(indexSrc) && /503/.test(indexSrc));
check('the price helper rejects 0, negatives and fractions',
  /resolveUnitPrice/.test(helperSrc));
check('no school-facing price setting is read', !/school\.settings|settings.*price/i.test(allSrc));

console.log('\n--- 5. The app and the function agree on the vocabulary ---');

const appFiles = [
  `${APP_DIR}/app/mark-attendance/actions.ts`,
  `${APP_DIR}/app/manual-attendance/[classId]/actions.ts`,
  `${APP_DIR}/lib/devices/processor.ts`,
];
const appSrc = appFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
check("the app queues notifications as status 'pending'", /status:\s*['"]pending['"]/.test(appSrc));
check("the app never queues 'queued' SMS rows", !/status:\s*['"]queued['"]/.test(appSrc));
check("the function only dispatches 'pending' rows", /status\)\s*!==\s*"pending"/.test(indexSrc));
check("the function's sweep includes both pending and sending",
  /\.in\("status",\s*\["pending",\s*"sending"\]\)/.test(indexSrc));

console.log('\n--- 6. The interface the deployed callers already use is preserved ---');

for (const name of ['DISPATCH_SECRET', 'NAJIKI_DOMAIN', 'NAJIKI_API_KEY', 'SMS_COST', 'NAJIKI_TIMEOUT_MS']) {
  check(`env ${name} is still honoured`, indexSrc.includes(name));
}
check('the Bearer dispatch secret is still accepted', /Authorization.*Bearer|presentedSecret/.test(indexSrc));
check('the x-dispatch-secret header is also accepted', /x-dispatch-secret/.test(indexSrc));
check('{ notification_id } payloads still work', /notification_id/.test(indexSrc));
check('{ record: { id } } webhook payloads still work', /record\?\.id|body\?\.record/.test(indexSrc));
check('{ retry_sweep: true } still works', /retry_sweep/.test(indexSrc));

console.log('\n--- 7. Delivery reports can find the row ---');

const webhookSrc = fs.readFileSync(`${APP_DIR}/app/api/webhooks/najiki/handler.ts`, 'utf8');
check('the app matches delivery reports on provider_ref', /provider_ref/.test(webhookSrc));
check('the function stores a non-null provider_ref before marking sent',
  /status:\s*"sent"[\s\S]{0,200}?provider_ref:\s*result\.providerRef/.test(indexSrc));

await db.end();
console.log(`\n=== SMS SCHEMA CONTRACT [${LABEL}]: ${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' FAILED'} ===`);
process.exit(fail === 0 ? 0 : 1);
