// Direct-REST money attack: school A's admin uses their own browser token
// against the Supabase API, bypassing the app. Only DB grants/RLS can stop it.
import pg from 'pg';
import { SHIM, setupUsers } from './lib.mjs';
import seed from './seed.js';
const { A, B } = seed.IDS;
const db = new pg.Client({ connectionString: 'postgres://postgres:pw@127.0.0.1:54329/mtlab' });
await db.connect();
await setupUsers();
const JWT = (await (await fetch(SHIM + '/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: 'adminA@lab.io', password: 'Passw0rd!' }) })).json()).access_token;
async function rest(method, path, { schema = 'school', body } = {}) {
  const h = { apikey: 'lab-anon-key', Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  h[method === 'GET' ? 'Accept-Profile' : 'Content-Profile'] = schema;
  const r = await fetch(SHIM + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  if (r.status >= 400) console.log("   ->", JSON.stringify(data).slice(0, 110));
  return { status: r.status, rows: Array.isArray(data) ? data : [] };
}
const q = async (s, p) => (await db.query(s, p)).rows;
await q("INSERT INTO school.payment_intents(school_id, reference, amount) VALUES ($1,'rlsA-'||gen_random_uuid(),1000),($2,'rlsB-'||gen_random_uuid(),2000)", [A.school, B.school]);
await q("SELECT school.log_payment_event('rls-ev-'||gen_random_uuid(),'r','held',$1,null,1,null,'test','{}'::jsonb)", [B.school]);
const bal = async (s) => Number((await q('SELECT coalesce(sum(balance),0) b FROM public.wallets WHERE tenant_id=$1', [s]))[0].b);
const res = [];
const rec = (name, vuln, info) => { res.push(vuln); console.log((vuln ? 'VULNERABLE ' : 'secure     ') + name + '  [' + info + ']'); };
let r = await rest('GET', 'payment_intents?select=school_id');
rec('read other school top-ups', r.rows.some((x) => x.school_id === B.school), r.status + ' rows=' + r.rows.length + ' ownOnly=' + r.rows.every((x) => x.school_id === A.school));
r = await rest('POST', 'payment_intents', { body: { school_id: A.school, reference: 'forged-' + Date.now(), amount: 5000000 } });
rec('forge own top-up intent (to pair with a fake webhook)', r.status < 300, r.status);
r = await rest('PATCH', 'payment_intents?school_id=eq.' + A.school, { body: { amount: 9999999 } });
rec('inflate pending intent amount', r.rows.length > 0, r.status);
r = await rest('GET', 'payment_events?select=id');
rec('read payment audit log', r.rows.length > 0, r.status + ' rows=' + r.rows.length);
r = await rest('DELETE', 'payment_events?id=gt.0');
rec('erase payment audit log', r.rows.length > 0, r.status);
const a0 = await bal(A.school);
r = await rest('POST', 'rpc/apply_payment', { body: { p_refs: ['x'], p_provider_ref: 'rpc-' + Date.now(), p_amount: 100000, p_currency: 'UGX', p_claimed_school: A.school, p_require_intent: false, p_detail: {} } });
rec('call apply_payment directly (self-credit)', (await bal(A.school)) > a0, r.status);
r = await rest('PATCH', 'wallets?tenant_id=eq.' + A.school, { schema: 'public', body: { balance: 99999999 } });
rec('set own wallet balance', (await bal(A.school)) > a0, r.status);
r = await rest('POST', 'transactions', { schema: 'public', body: { tenant_id: A.school, amount: 50000, type: 'credit', status: 'completed', reference: 'fake-' + Date.now() } });
rec('insert fake credit transaction', r.status < 300, r.status);
console.log(res.filter(Boolean).length + '/' + res.length + ' vulnerable');
await db.end();
