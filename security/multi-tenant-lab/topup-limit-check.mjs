// Default top-up limit: 6 per school per 10 minutes, then a friendly refusal.
// Run against an app started WITHOUT TOPUP_MAX_PER_10_MIN.
import { execSync } from 'child_process';
import { setupUsers, sessionCookie, actionIds, callAction, SHIM } from './lib.mjs';
const [BASE, APPDIR] = process.argv.slice(2);
execSync('node seed.js', { cwd: '/home/user/mt-lab' });
await fetch(SHIM + '/__reload', { method: 'POST' });
await setupUsers();
const ck = await sessionCookie('adminA@lab.io');
const a = actionIds(APPDIR).topUpBalance[0];
const out = [];
for (let i = 0; i < 8; i++) {
  const r = await callAction(BASE, '/dashboard/attendance', a.id, [1000, '0772123456'], ck);
  out.push(r.value && r.value.success ? 'ok' : 'refused:' + String(r.value && r.value.error).slice(0, 60));
}
console.log(out.join('\n'));
const okCount = out.filter((x) => x === 'ok').length;
console.log(okCount === 6 && out[6].includes('Too many') ? 'PASS: 6 allowed, then refused' : 'FAIL');
