// Schema + source contract for the deployed SMS sender.
//
// The live project is the source of truth. This suite pins down the facts the
// deployed function depends on, so the repo cannot drift away from them again:
//
//   school.notifications : retry_count, next_retry_at, error,
//                          status default 'pending', provider_response (text)
//   wallet RPC           : public.debit_sms_wallet(p_wallet_id text, p_amount
//                            numeric, p_idempotency_key text, p_tenant_id text,
//                            p_description text)
//   function             : send-attendance-sms
//
// Part database, part static analysis, no Deno required.
//
// Usage: node sms-schema-contract-check.mjs [label]
import fs from 'fs';
import pg from 'pg';

const [LABEL = 'run'] = process.argv.slice(2);
const FN_DIR = '/home/user/schoolmnt2/supabase/functions';
const APP_DIR = '/home/user/schoolmnt2';

let fail = 0;
const check = (name, pass, detail = '') => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
};

const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

console.log('\n--- 1. public.debit_sms_wallet, exactly as deployed ---');

const fns = await q(`
  SELECT n.nspname AS schema, pg_get_function_identity_arguments(p.oid) AS args,
         p.prosecdef AS security_definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'debit_sms_wallet'`);
const pub = fns.find((f) => f.schema === 'public');
check('public.debit_sms_wallet exists with the deployed signature',
  !!pub && pub.args === 'p_wallet_id text, p_amount numeric, p_idempotency_key text, p_tenant_id text, p_description text',
  pub ? pub.args : JSON.stringify(fns.map((f) => `${f.schema}(${f.args})`)));
check('it is SECURITY DEFINER', pub?.security_definer === true);

const acl = await q(`
  SELECT r.rolname, has_function_privilege(r.rolname,
           'public.debit_sms_wallet(text, numeric, text, text, text)', 'EXECUTE') AS can
    FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')`);
for (const r of acl) {
  check(`${r.rolname} ${r.rolname === 'service_role' ? 'can' : 'cannot'} execute it`,
    r.rolname === 'service_role' ? r.can : !r.can);
}

// Behaviour, not just existence.
const wallet = (await q('SELECT id, balance FROM public.wallets WHERE tenant_id=$1 LIMIT 1', ['aaaaaaaa-0000-4000-8000-000000000001']))[0];
const key = 'sms:probe-' + Date.now();
const d1 = (await q('SELECT public.debit_sms_wallet($1,$2,$3,$4,$5) AS r',
  [wallet.id, 30, key, 'aaaaaaaa-0000-4000-8000-000000000001', 'probe']))[0].r;
const d2 = (await q('SELECT public.debit_sms_wallet($1,$2,$3,$4,$5) AS r',
  [wallet.id, 30, key, 'aaaaaaaa-0000-4000-8000-000000000001', 'probe']))[0].r;
check('a first call debits', d1.outcome === 'debited', JSON.stringify(d1));
check('the same idempotency key never charges twice', d2.outcome === 'duplicate', JSON.stringify(d2));

let insufficient = null;
try {
  await q('SELECT public.debit_sms_wallet($1,$2,$3,$4,$5)',
    [wallet.id, 10_000_000, 'sms:probe-huge-' + Date.now(), 'aaaaaaaa-0000-4000-8000-000000000001', 'probe']);
} catch (e) {
  insufficient = e.message;
}
check('an unaffordable SMS raises, so the sender does not send', /insufficient/i.test(insufficient || ''), String(insufficient));

let crossTenant = null;
try {
  await q('SELECT public.debit_sms_wallet($1,$2,$3,$4,$5)',
    [wallet.id, 1, 'sms:probe-cross-' + Date.now(), 'bbbbbbbb-0000-4000-8000-000000000001', 'probe']);
} catch (e) {
  crossTenant = e.message;
}
check('a wallet id with the wrong tenant is refused', /not found for tenant/i.test(crossTenant || ''), String(crossTenant));

console.log('\n--- 2. school.notifications, exactly as deployed ---');

const cols = Object.fromEntries((await q(`
  SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
   WHERE table_schema = 'school' AND table_name = 'notifications'`)).map((r) => [r.column_name, r]));

check('retry_count exists (integer, default 0, not null)',
  cols.retry_count?.data_type === 'integer' && /0/.test(cols.retry_count?.column_default || '') && cols.retry_count?.is_nullable === 'NO',
  JSON.stringify(cols.retry_count));
check('next_retry_at exists (timestamptz)', cols.next_retry_at?.data_type === 'timestamp with time zone',
  JSON.stringify(cols.next_retry_at));
check('error exists (text)', cols.error?.data_type === 'text', JSON.stringify(cols.error));
check('provider_response is text, not jsonb', cols.provider_response?.data_type === 'text',
  JSON.stringify(cols.provider_response));
check("status defaults to 'pending'", /'pending'/.test(cols.status?.column_default || ''),
  String(cols.status?.column_default));

console.log('\n--- 3. The deployed function is the one in the repo ---');

check('supabase/functions/send-attendance-sms exists', fs.existsSync(`${FN_DIR}/send-attendance-sms/index.ts`));
check('the never-deployed send-sms function is gone', !fs.existsSync(`${FN_DIR}/send-sms`));

const src = fs.readFileSync(`${FN_DIR}/send-attendance-sms/index.ts`, 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('it writes retry_count', /retry_count:/.test(code));
check('it writes next_retry_at', /next_retry_at:/.test(code));
check('it writes error', /\berror:/.test(code));
check('it calls the 5-argument wallet RPC', /p_wallet_id:/.test(code) && /p_idempotency_key:/.test(code) &&
  /p_tenant_id:/.test(code) && /p_amount:/.test(code));
check('it calls the RPC in the public schema (no .schema() prefix)', /supabase\.rpc\(\s*["']debit_sms_wallet/.test(code));
check('it does not reference provider_ref', !/provider_ref/.test(code));
check('it stores JSON text in provider_response', /JSON\.stringify\(/.test(code));
check('it charges before sending', code.indexOf('debit_sms_wallet') < code.indexOf('/api/messaging/send'));
check("it only dispatches status='pending'", /status !== "pending"/.test(code));
check('the retry sweep filters retry_count < 5', /\.lt\("retry_count",\s*MAX_ATTEMPTS\)/.test(code));

console.log('\n--- 4. The two additive fixes are present ---');

check('an Idempotency-Key header is sent to NaJiki', /["']Idempotency-Key["']\s*:/.test(code));
check('the idempotency key is one per notification', /`sms:\$\{notificationId\}`/.test(code));
check('the dispatch secret is compared in constant time', /safeEqual\(/.test(code));
check('an undeliverable number is rejected before the wallet is touched',
  /MSISDN_RE/.test(code) && code.indexOf('MSISDN_RE.test') < code.indexOf('debit_sms_wallet'));
check('unsendable content is rejected before the wallet is touched',
  /MAX_MESSAGE_CHARS/.test(code) && code.indexOf('MAX_MESSAGE_CHARS') < code.indexOf('debit_sms_wallet'));
check('a 2xx is not enough: the payload must not admit failure',
  /payloadSaysFailed/.test(code));
check('a 2xx without an smsId is retried, not marked sent',
  /provider_ack_without_id/.test(code));
check('the wallet lookup falls back to school_id',
  /\.eq\("school_id",\s*schoolIdText\)/.test(code));
check('SMS_COST has no positive fallback (only an invalid "0")',
  !/SMS_COST[^\n]*\|\|\s*["']?[1-9]/.test(code));
check('a missing price returns 503', /SMS pricing is not configured/.test(src));

console.log('\n--- 5. The app agrees with the sender ---');

const appFiles = [
  `${APP_DIR}/app/mark-attendance/actions.ts`,
  `${APP_DIR}/app/manual-attendance/[classId]/actions.ts`,
  `${APP_DIR}/lib/devices/processor.ts`,
];
const appSrc = appFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
check("the app queues notifications as status 'pending'", /status:\s*['"]pending['"]/.test(appSrc));
const webhook = fs.readFileSync(`${APP_DIR}/app/api/webhooks/najiki/handler.ts`, 'utf8');
check('the delivery webhook survives a database without provider_ref',
  /isMissingProviderRefColumn/.test(webhook));
check('and can fall back to matching the notification id', /UUID_RE\.test\(v\)/.test(webhook) || /idCandidates/.test(webhook));
check('the sender passes our notification id as smsId so that fallback can match',
  /smsId:\s*notif\.id/.test(code));

console.log('\n--- 5b. Charged-but-undelivered is visible and refundable ---');

const mig16 = `${APP_DIR}/supabase_migrations/16_refund_sms_charge.sql`;
check('migration 16 exists', fs.existsSync(mig16));
const mig16Sql = fs.existsSync(mig16) ? fs.readFileSync(mig16, 'utf8') : '';
check('a refund RPC exists and is SECURITY DEFINER',
  /CREATE OR REPLACE FUNCTION public\.refund_sms_charge/.test(mig16Sql) && /SECURITY DEFINER/.test(mig16Sql));
check('anon and authenticated cannot call it',
  /REVOKE ALL ON FUNCTION public\.refund_sms_charge/.test(mig16Sql) &&
  /'anon', 'authenticated'/.test(mig16Sql));
check('refunds are idempotent through a ledger reference',
  /sms_refund:/.test(mig16Sql) && /duplicate/.test(mig16Sql));

check('terminal failures after a successful debit carry a marker',
  /function failCode\(/.test(code) && /charged_undelivered:/.test(code));
check('the marker is only added on the final attempt',
  /isFinalAttempt && charged \?/.test(code));
check('the flag is reset per row, not shared across the batch',
  /let chargedThisRow = false/.test(code) && /chargedThisRow = true/.test(code));
check('a late success clears a stale error', /error:\s*null/.test(code));

console.log('\n--- 5c. Timeouts, backoff and the sweep are bounded ---');

check('the claim lock is derived from the send timeout, not a constant',
  /sendTimeoutMs/.test(code) && /lockMs\s*=\s*Math\.max\(/.test(code));
check('the lock always outlives the send', /Math\.max\(\s*60_?000/.test(code) || /Math\.max\(60000/.test(code));
check('Retry-After is parsed', /function parseRetryAfter\(/.test(code));
check('both numeric and HTTP-date Retry-After are accepted',
  /Number\.isFinite\(asNumber\)/.test(code) && /Date\.parse\(trimmed\)/.test(code));
check('the honoured backoff is clamped to an hour', /Math\.min\([^)]*3600/.test(code));
check('a missing Retry-After falls back to a sane default',
  /DEFAULT_BACKOFF_SEC\s*=\s*180/.test(code));
check('the call site actually prefers the gateway value',
  /retryAfterSec\s*\?\?\s*DEFAULT_BACKOFF_SEC/.test(code));
check('the sweep enforces a wall-clock budget',
  /SMS_SWEEP_BUDGET_MS/.test(code) && /stopped_early/.test(code));
check('the older SMS_BATCH_BUDGET_MS secret is still honoured',
  /SMS_BATCH_BUDGET_MS/.test(code));
check('the budget is checked before starting each row, not after the batch',
  code.indexOf('Date.now() - startedAt > budgetMs') < code.indexOf('stoppedEarly = true'));

console.log('\n--- 6. Deployment instructions match reality ---');

const docs = fs.readFileSync(`${APP_DIR}/SECURITY_AUDIT.md`, 'utf8');
check('the deploy line names send-attendance-sms', /functions deploy send-attendance-sms/.test(docs));
check('it does not tell anyone to disable JWT verification for it',
  !/deploy send-attendance-sms --no-verify-jwt/.test(docs));
check('the sweep is documented as needing a scheduler', /cron|scheduler|pg_cron/i.test(docs));

await db.end();
console.log(`\n=== SMS SCHEMA CONTRACT [${LABEL}]: ${fail === 0 ? 'ALL CHECKS PASSED' : fail + ' FAILED'} ===`);
process.exit(fail === 0 ? 0 : 1);
