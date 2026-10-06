import { setupUsers, sessionCookie } from './lib.mjs';
await setupUsers();
const ck = await sessionCookie('adminA@lab.io');
for (const base of (process.argv[2] ? [process.argv[2]] : ['http://127.0.0.1:3201', 'http://127.0.0.1:3202'])) {
  for (const p of ['/dashboard', '/dashboard/people', '/dashboard/classes', '/dashboard/devices', '/dashboard/attendance', '/mark-attendance', '/manual-attendance/aaaaaaaa-0000-4000-8000-0000000000c1', '/login']) {
    const r = await fetch(base + p, { headers: { cookie: ck }, redirect: 'manual' });
    console.log(base.slice(-4), p, r.status, r.headers.get('location') || '');
  }
}
