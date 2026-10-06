import { setupUsers, sessionCookie } from '/home/user/mt-lab/lib.mjs';
await setupUsers();
const c = await sessionCookie('adminA@lab.io');
for (const p of ['/dashboard', '/dashboard/people', '/dashboard/classes', '/dashboard/devices', '/dashboard/attendance']) {
  const h = await (await fetch('http://127.0.0.1:3201' + p, { headers: { cookie: c } })).text();
  console.log(p, 'A data:', /A-SECRETNAME|Alpha Academy|Class A/.test(h), ' B data:', /B-SECRET|Beta/.test(h));
}
