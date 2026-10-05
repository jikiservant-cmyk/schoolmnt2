// Direct-REST tenant attack: school A's admin uses their OWN login token
// (copied from the browser) to talk to the Supabase REST API directly,
// bypassing every check in the Next.js app. Only RLS can stop this.
// Usage: node rls-attack.mjs [label]   -> writes rls-results-<label>.json
import fs from 'fs';
import { SHIM, setupUsers } from './lib.mjs';
import seed from './seed.js';
const { IDS } = seed;
const A = IDS.A, B = IDS.B;
const label = process.argv[2] || 'run';

await setupUsers();
const login = await (await fetch(SHIM + '/auth/v1/token?grant_type=password', {
  method: 'POST', body: JSON.stringify({ email: 'adminA@lab.io', password: 'Passw0rd!' }),
})).json();
const JWT = login.access_token;

async function rest(method, path, { schema = 'school', body, token = JWT, apikey = 'lab-anon-key' } = {}) {
  const h = { apikey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  h[method === 'GET' ? 'Accept-Profile' : 'Content-Profile'] = schema;
  const r = await fetch(SHIM + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data, rows: Array.isArray(data) ? data : [] };
}
// Make sure B owns rows in every table (as the server/service role), so an
// empty result really means "blocked", not "nothing there".
const SVC = { token: 'lab-service-key', apikey: 'lab-service-key' };
const tag = 'B-SECRET-' + Date.now();
await rest('POST', 'academic_years', { ...SVC, body: { school_id: B.school, name: tag } });
await rest('POST', 'device_logs', { ...SVC, body: { school_id: B.school, device_id: B.device, raw_data: tag } });
await rest('POST', 'attendance_logs', { ...SVC, body: { school_id: B.school, person_id: B.student, status: 'present', notes: tag } });
await rest('POST', 'person_credentials', { ...SVC, body: { school_id: B.school, person_id: B.student, identifier_value: tag, identifier_type: 'card' } });
await rest('POST', 'notifications', { ...SVC, body: { school_id: B.school, recipient_id: B.parent, message: tag, status: 'pending' } });
await rest('PATCH', 'devices?school_id=eq.' + A.school, { ...SVC, body: { device_secret: 'A-plain-secret-for-test' } });
const results = [];
const check = (name, vulnerable, detail) => { results.push({ name, vulnerable: !!vulnerable, detail }); console.log((vulnerable ? 'VULN ' : 'ok   ') + name + (detail ? '  -> ' + detail : '')); };
const hasB = (rows) => rows.some((r) => JSON.stringify(r).includes('bbbbbbbb') || JSON.stringify(r).includes('B-SECRET'));

// ---- READ: can A see B's rows? ----
for (const t of ['people', 'classes', 'academic_years', 'devices', 'device_commands', 'device_logs', 'attendance_logs', 'parents', 'person_credentials', 'notifications', 'staff_users', 'student_parents']) {
  const r = await rest('GET', t + '?select=*');
  check('read B ' + t, hasB(r.rows), r.status + ' rows=' + r.rows.length);
}
const sch = await rest('GET', 'schools?select=id,name,settings');
check('read B schools row', hasB(sch.rows), 'rows=' + sch.rows.length);
// ---- secrets readable by a normal admin token ----
const pin = await rest('GET', 'staff_users?select=pin_hash');
check('read staff pin_hash', pin.rows.some((r) => r.pin_hash), pin.status + ' ' + (pin.data && pin.data.code || ''));
const dsec = await rest('GET', 'devices?select=device_secret');
check('read device_secret', dsec.rows.some((r) => r.device_secret), dsec.status + ' ' + (dsec.data && dsec.data.code || ''));
// ---- WRITE into B ----
let r = await rest('POST', 'people', { body: { school_id: B.school, full_name: 'A-INJECTED', role: 'student' } });
check('insert person into B', r.status < 300, r.status);
r = await rest('PATCH', 'people?id=eq.' + B.student, { body: { full_name: 'A-DEFACED' } });
check('update B student', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
r = await rest('PATCH', 'people?id=eq.' + A.student, { body: { school_id: B.school } });
check('move own student into B', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
r = await rest('POST', 'device_commands', { body: { school_id: B.school, device_id: B.device, raw_command: 'C:1:CLEAR DATA', status: 'pending' } });
check('queue command on B device', r.status < 300, r.status);
r = await rest('PATCH', 'devices?id=eq.' + B.device, { body: { school_id: A.school } });
check('steal B device', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
r = await rest('DELETE', 'attendance_logs?school_id=eq.' + B.school);
check('delete B attendance', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
r = await rest('PATCH', 'staff_users?auth_user_id=eq.' + A.admin, { body: { school_id: B.school } });
check('re-home own admin into B', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
r = await rest('POST', 'staff_users', { body: { school_id: B.school, auth_user_id: A.admin, staff_role: 'admin' } });
check('grant self admin in B', r.status < 300, r.status);
// ---- own-school abuse that skips app checks ----
r = await rest('PATCH', 'schools?id=eq.' + A.school, { body: { settings: { sms_balance: 999999 } } });
check('self-credit SMS balance (schools.settings)', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
r = await rest('PATCH', 'staff_users?auth_user_id=eq.' + A.admin, { body: { pin_hash: 'x', failed_attempts: 0 } });
check('write own pin_hash/lockout directly', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
r = await rest('PATCH', 'wallets?tenant_id=eq.' + A.school, { schema: 'public', body: { balance: 999999 } });
check('self-credit wallet', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
r = await rest('GET', 'wallets?select=*', { schema: 'public' });
check('read B wallet', hasB(r.rows), 'rows=' + r.rows.length);
r = await rest('PATCH', 'admin_profiles?id=eq.' + A.admin, { schema: 'public', body: { school_id: B.school } });
check('re-point own admin_profile to B', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
// ---- anonymous (public anon key only) ----
for (const t of ['people', 'devices', 'staff_users', 'schools']) {
  const x = await rest('GET', t + '?select=id', { token: 'lab-anon-key' });
  check('anon read ' + t, x.rows.length > 0, x.status + ' rows=' + x.rows.length);
}
// ---- sanity: service role (server) still sees everything ----
const svc = await rest('GET', 'people?select=id', { token: 'lab-service-key', apikey: 'lab-service-key' });
const svcOk = hasB(svc.rows) && svc.rows.some((x) => x.id.startsWith('aaaaaaaa'));
const own = await rest('GET', 'people?select=id');
const ownOk = own.rows.some((x) => x.id.startsWith('aaaaaaaa'));
console.log('sanity: service sees all=' + svcOk + ', A sees own=' + ownOk);
const vuln = results.filter((x) => x.vulnerable).length;
console.log(`\n${vuln}/${results.length} vulnerable`);
fs.writeFileSync(`rls-results-${label}.json`, JSON.stringify({ vuln, total: results.length, svcOk, ownOk, results }, null, 1));
