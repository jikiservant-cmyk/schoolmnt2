// Round 4 money pentest (SECURITY_AUDIT.md Part 7).
// Usage: RLS=1 node round4-attack.mjs <label>   (MIG07=0 = without migration 07)
import pg from 'pg';
import fs from 'fs';
import { execSync } from 'child_process';
import { setupUsers, SHIM } from './lib.mjs';
import seedMod from './seed.js';
const { IDS: { A } } = seedMod;
const LABEL = process.argv[2] || 'run';
execSync('node seed.js', { cwd: '/home/user/mt-lab', env: process.env });
await fetch(SHIM + '/__reload', { method: 'POST' });
await setupUsers();
const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
const results = []; const broken = [];
const rec = (n, v, d) => { results.push({ name: n, vulnerable: !!v, detail: String(d) }); console.log((v ? 'VULNERABLE ' : 'secure     ') + n + '  [' + d + ']'); };
const legit = (n, ok, d) => { if (!ok) broken.push(n); console.log((ok ? 'legit-ok   ' : 'LEGIT-FAIL ') + n + '  [' + d + ']'); };
const tok = async (e) => (await (await fetch(SHIM + '/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: e, password: 'Passw0rd!' }) })).json()).access_token;
const teacher = await tok('teacherA@lab.io');
const rpc = async (bearer, fn, body, schema = 'public') => {
  const r = await fetch(SHIM + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: 'lab-anon-key', Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json', 'Content-Profile': schema }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.text() };
};
const schools = async () => Number((await q('SELECT count(*) n FROM school.schools'))[0].n);

// R1/R2: provisioning function callable by the public key / any user
let s0 = await schools();
let r = await rpc('lab-anon-key', 'rp_create_school_from_admin_profile', { p_admin_profile_id: 'bbbbbbbb-0000-4000-8000-0000000000a1' });
rec('R1 anonymous visitor runs signup provisioning for any profile (creates schools + NaJiki tenants)', (await schools()) > s0, r.status + ' ' + r.body.slice(0, 80));
s0 = await schools();
r = await rpc(teacher, 'rp_create_school_from_admin_profile', { p_admin_profile_id: 'aaaaaaaa-0000-4000-8000-0000000000a2' });
rec('R2 teacher runs signup provisioning', (await schools()) > s0, r.status + ' ' + r.body.slice(0, 80));
s0 = await schools();
r = await rpc('lab-service-key', 'rp_create_school_from_admin_profile', { p_admin_profile_id: 'cccccccc-0000-4000-8000-0000000000a1' });
legit('signup (service role) can still provision a school', (await schools()) === s0 + 1, r.status);

// R3: stale settings.balance re-minted after the wallet row is deleted
const pay = async (school, amount) => {
  const ref = 'r4-' + Math.random().toString(36).slice(2);
  await q("INSERT INTO school.payment_intents(school_id, reference, amount) VALUES ($1,$2,$3)", [school, ref, amount]);
  return (await q("SELECT school.apply_payment(ARRAY[$1]::text[], $2, $3, 'UGX', $4, true, '{}'::jsonb) r", [ref, 'prov-' + ref, amount, school]))[0].r;
};
const walletBal = async (s) => Number((await q('SELECT coalesce(sum(balance),0) b FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [s]))[0].b);
await q('UPDATE public.wallets SET balance=0 WHERE tenant_id=$1 OR school_id=$1', [A.school]); await q('DELETE FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [A.school]);
await pay(A.school, 100000);                                            // school tops up 100,000
await q('UPDATE public.wallets SET balance = 0 WHERE tenant_id=$1 OR school_id=$1', [A.school]); // ...and spends it all on SMS
const stale = (await q('SELECT settings->>\'balance\' b FROM school.schools WHERE id=$1', [A.school]))[0].b;
await q('UPDATE public.wallets SET balance=0 WHERE tenant_id=$1 OR school_id=$1', [A.school]); await q('DELETE FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [A.school]); // wallet row removed (duplicate cleanup)
await pay(A.school, 500);
const after = await walletBal(A.school);
rec('R3 stale legacy settings.balance re-minted after wallet row deleted', after > 500, 'stale settings.balance=' + stale + ', wallet after 500 top-up=' + after);

// legit: a school that never used wallets keeps its legacy balance on first top-up
const fresh = (await q("INSERT INTO school.schools(id, name, settings) VALUES (gen_random_uuid(), 'Legacy School', '{\"balance\": 7000}') RETURNING id"))[0].id;
await pay(fresh, 1000);
legit('legacy balance carried over on a school\'s first top-up', (await walletBal(fresh)) === 8000, 'wallet=' + (await walletBal(fresh)));

// R5: a wallet still holding money is deleted (credit vanishes / stale re-mint)
await pay(A.school, 4000);
let delErr = '';
try { await q('DELETE FROM public.wallets WHERE tenant_id=$1 OR school_id=$1', [A.school]); } catch (e) { delErr = e.message; }
rec('R5 wallet still holding money can be deleted', !delErr, delErr ? delErr.slice(0, 90) : 'deleted; balance now ' + (await walletBal(A.school)));
legit('wallet still shows its money after the refused delete', (await walletBal(A.school)) >= 4000, 'wallet=' + (await walletBal(A.school)));

// R4: anon key executes school-schema functions
// (the lab shim answers auth_school_id itself, so ask Postgres directly as anon)
let anonExec = '';
try { await q('BEGIN'); await q('SET LOCAL ROLE anon'); await q('SELECT school.auth_school_id()'); anonExec = 'executed'; } catch (e) { anonExec = e.code + ' ' + e.message; } finally { await q('ROLLBACK'); }
rec('R4 anonymous role executes school-schema functions', anonExec === 'executed', anonExec.slice(0, 70));
r = await rpc(teacher, 'auth_school_id', {}, 'school');
legit('logged-in user can still run school.auth_school_id (RLS/app need it)', r.status === 200 && r.body.includes(A.school), r.status + ' ' + r.body.slice(0, 60));

const v = results.filter((x) => x.vulnerable).length;
console.log(`\n[${LABEL}] ${v} vulnerable / ${results.length} checks; legit failures: ${broken.length ? broken.join(', ') : 'none'}`);
fs.writeFileSync(`/home/user/mt-lab/round4-results-${LABEL}.json`, JSON.stringify({ vulnerable: v, total: results.length, broken, results }, null, 1));
await db.end();
