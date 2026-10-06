// A logged-in user with NO school membership opens /dashboard/people.
// Old code ran the classes query unscoped and listed every school's classes.
import { SHIM, setupUsers } from './lib.mjs';
await setupUsers();
await fetch(SHIM + '/__users', { method: 'POST', body: JSON.stringify({
  'adminA@lab.io': { id: 'aaaaaaaa-0000-4000-8000-0000000000a1', email: 'adminA@lab.io', password: 'Passw0rd!' },
  'adminB@lab.io': { id: 'bbbbbbbb-0000-4000-8000-0000000000a1', email: 'adminB@lab.io', password: 'Passw0rd!' },
  'orphan@lab.io': { id: 'cccccccc-0000-4000-8000-0000000000a1', email: 'orphan@lab.io', password: 'Passw0rd!' },
}) });
const s = await (await fetch(SHIM + '/__session', { method: 'POST', body: JSON.stringify({ email: 'orphan@lab.io' }) })).json();
const cookie = 'sb-127-auth-token=base64-' + Buffer.from(JSON.stringify(s)).toString('base64url');
const r = await fetch('http://127.0.0.1:3201/dashboard/people', { headers: { cookie }, redirect: 'manual' });
const h = await r.text();
const leak = /Class A|Class B|B-SECRET|A-SECRET/.test(h);
console.log('status', r.status, r.headers.get('location') || '', 'leaks other schools classes:', leak);
