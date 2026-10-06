// Pushing student / teacher names to the device screen, end to end.
// A simulated ZKTeco terminal that follows the official PUSH protocol strictly
// polls the real app, applies the commands to its own user list, and replies.
// Usage: node device-names-check.mjs <base> <appDir>     (re-seeds the DB; honours RLS=1)
import pg from 'pg';
import { execSync } from 'child_process';
import { setupUsers, sessionCookie, actionIds, callAction, SHIM } from './lib.mjs';
import seedMod from './seed.js';
const [BASE = 'http://127.0.0.1:3201', APPDIR = '/home/user/schoolmnt2'] = process.argv.slice(2);
const SECRETS = { SNA0001: 'A-device-secret-0123456789', SNB0001: 'B-device-secret-9876543210' };
const CLS_A = seedMod.IDS.A.cls;

execSync('node seed.js', { cwd: '/home/user/mt-lab' });
await fetch(SHIM + '/__reload', { method: 'POST' });
await setupUsers();
const ids = actionIds(APPDIR);
const ck = await sessionCookie('adminA@lab.io');
const act = (n, args) => { const a = ids[n][0]; return callAction(BASE, '/' + a.page.replace(/^app\//, '').replace(/\/page$/, ''), a.id, args, ck); };
const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

let failures = 0;
const check = (name, pass, detail = '') => { if (!pass) failures++; console.log(`${pass ? 'OK    ' : 'FAILED'} ${name}${detail ? '  [' + detail + ']' : ''}`); };

// ---------------- the simulated terminal ----------------
class Terminal {
  constructor(sn) { this.sn = sn; this.users = new Map(); this.rejected = []; this.stray = []; }
  async poll() {
    const qs = new URLSearchParams({ SN: this.sn, token: SECRETS[this.sn] });
    const body = await (await fetch(`${BASE}/iclock/getrequest?${qs}`)).text();
    if (body.trim() === 'OK') return 0;
    const replies = [];
    let n = 0;
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      const m = /^C:([^:]*):(.*)$/.exec(line);
      if (!m) { this.stray.push(line); continue; }         // not a command line at all
      const [, id, cmd] = m;
      n++;
      // Spec: "CmdID ... numbers and letters, length not over 16".
      if (process.env.LENIENT_ID !== '1' && !/^[A-Za-z0-9]{1,16}$/.test(id)) { this.rejected.push(`bad command id (${id.length} chars)`); continue; }
      // Real firmware: only the exact DATA UPDATE/DELETE USERINFO forms (others: -1002).
      const d = /^DATA (UPDATE|DELETE) USERINFO (.*)$/.exec(cmd);
      if (!d) { this.rejected.push(`unknown command: ${cmd.slice(0, 30)}`); replies.push(`ID=${id}&Return=-1002&CMD=DATA`); continue; }
      const f = Object.fromEntries(d[2].split('\t').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
      if (d[1] === 'UPDATE') this.users.set(f.PIN, { name: f.Name, pri: f.Pri });
      else this.users.delete(f.PIN);
      replies.push(`ID=${id}&Return=0&CMD=DATA`);
    }
    if (replies.length) {
      const qs2 = new URLSearchParams({ SN: this.sn, token: SECRETS[this.sn] });
      await fetch(`${BASE}/iclock/devicecmd?${qs2}`, { method: 'POST', body: replies.join('\n') + '\n' });
    }
    return n;
  }
  async drain() { let total = 0; for (let i = 0; i < 10; i++) { const n = await this.poll(); total += n; if (!n) break; } return total; }
  screen(pin) { return this.users.get(pin)?.name; }
}
const devA = new Terminal('SNA0001'), devB = new Terminal('SNB0001');
await devA.drain(); await devB.drain();            // seed's leftover command
devA.rejected = []; devB.rejected = [];
const t0 = new Date().toISOString();
const show = (pin) => JSON.stringify(devA.screen(pin) ?? null);

// 1. "Push all users to device" button
const r1 = await act('pushAllUsersToDeviceAction', ['SNA0001']);
await devA.drain();
check('push-all button: teacher 101 appears on the device', /^(Tr\. )?Teacher A-SECRETNAME$/.test(devA.screen('101') || ''), `queued ${r1.value?.count ?? JSON.stringify(r1.value).slice(0, 60)}, screen ${show('101')}`);
check('push-all button: student 102 appears (full name kept; long class left out)', devA.screen('102') === 'Student A-SECRETNAME', `screen ${show('102')}`);

// 2. Register a new student with a device ID
const add = async (fullName, role, deviceUserId, extra = {}) => {
  const fd = new FormData();
  fd.append('fullName', fullName); fd.append('role', role); fd.append('deviceUserId', deviceUserId);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return act('addPersonAction', [fd]);
};
const s = await add('Nakato Sarah', 'student', '150', { classId: CLS_A, guardianName: 'Mama Sarah', guardianPhone: '0772555111', guardianRelationship: 'mother' });
await devA.drain();
check('new student appears on the device (full name, not chopped)', devA.screen('150') === 'Nakato Sarah', `${s.value?.success ? 'saved' : JSON.stringify(s.value).slice(0, 80)}, screen ${show('150')}`);

// 3. Register a new teacher
const t = await add('Okello James', 'teacher', '151', { phone: '0772555222' });
await devA.drain();
check('new teacher appears as "Tr. Okello James"', devA.screen('151') === 'Tr. Okello James', `${t.value?.success ? 'saved' : JSON.stringify(t.value).slice(0, 80)}, screen ${show('151')}`);

// 4. Change the student's device ID 150 -> 155
const sid = (await q(`SELECT id FROM school.people WHERE full_name='Nakato Sarah'`))[0]?.id;
await act('updatePersonDeviceUserIdAction', [sid, '155']);
await devA.drain();
check('device ID changed 150 -> 155: name now on 155', devA.screen('155') === 'Nakato Sarah', `screen 155 ${show('155')}`);
check('device ID changed 150 -> 155: old 150 entry removed (no ghost)', devA.screen('150') === undefined, `screen 150 ${show('150')}`);

// 5. Remove the student's device ID
await act('updatePersonDeviceUserIdAction', [sid, null]);
await devA.drain();
check('device ID removed: student no longer on the device', devA.screen('155') === undefined, `screen 155 ${show('155')}`);

// 6. A name that tries to smuggle device commands / admin rights
const evil = await add('Evil\tPri=14\nC:77:DATA DELETE USERINFO PIN=101', 'teacher', '152', { phone: '0772555333' });
await devA.drain();
const e = devA.users.get('152');
check('hostile name: stored safely, no admin rights, no extra command', (!evil.value?.success && !e) || (e && e.pri === '0' && !/[\t\n=]/.test(e.name) && devA.screen('101') !== undefined && devA.stray.length === 0), `${evil.value?.success ? 'saved' : 'refused'}, entry ${JSON.stringify(e ?? null)}, teacher 101 still there: ${devA.screen('101') !== undefined}`);

// 7. Non-English letters and apostrophes
await add("Zoë N'Kurunziza", 'teacher', '153', { phone: '0772555444' });
await devA.drain();
check('name with ë and apostrophe shows exactly', devA.screen('153') === "Tr. Zoë N'Kurunziza", `screen ${show('153')}`);

// 8. Long name is trimmed to fit the screen (24 characters)
await add('Ssekandi Mukasa Byaruhanga Nalwoga', 'teacher', '154', { phone: '0772555555' });
await devA.drain();
check('very long name trimmed to 24 characters', (devA.screen('154') || '').length > 0 && devA.screen('154').length <= 24, `screen ${show('154')}`);

// 8b. Student in a normal short class shows the class too
const P5 = (await q(`INSERT INTO school.classes(school_id,name) VALUES ($1,'P.5') RETURNING id`, [seedMod.IDS.A.school]))[0].id;
await add('Namubiru Joan', 'student', '157', { classId: P5, guardianName: 'Papa Joan', guardianPhone: '0772555666', guardianRelationship: 'father' });
await devA.drain();
check('student in class P.5 shows "Namubiru Joan (P.5)"', devA.screen('157') === 'Namubiru Joan (P.5)', `screen ${show('157')}`);

// 9. "Auto-assign device IDs" button for someone without one
await q(`INSERT INTO school.people(school_id,full_name,role,is_active) VALUES ($1,'Auma Grace','support_staff',true)`, [seedMod.IDS.A.school]);
const aa = await act('autoAssignDevicePinsAction', [{ deviceSerialNumber: 'SNA0001', category: 'all' }]);
await devA.drain();
const graceId = (await q(`SELECT device_user_id FROM school.people WHERE full_name='Auma Grace'`))[0]?.device_user_id;
check('auto-assign button: new ID given and name appears on the device', !!graceId && /Auma Grace/.test(devA.screen(graceId) || ''), `${JSON.stringify(aa.value).slice(0, 70)}, ID ${graceId}, screen ${JSON.stringify(devA.screen(graceId) ?? null)}`);

const tooLong = [...devA.users.values()].filter((u) => Array.from(u.name || '').length > 24);
check('no name on the device is longer than the 24-character screen', tooLong.length === 0, tooLong.map((u) => u.name).join(' | '));

// ---- device protocol health ----
check('device accepted every command (no bad IDs / unknown commands)', devA.rejected.length === 0, devA.rejected.slice(0, 3).join(' | '));
const stuck = await q(`SELECT status, count(*) n FROM school.device_commands WHERE target_serial='SNA0001' AND created_at >= $1 GROUP BY status ORDER BY status`, [t0]);
const notDone = stuck.filter((r) => r.status !== 'acknowledged');
check('every command the device ran is marked "acknowledged" in the app', notDone.length === 0, stuck.map((r) => `${r.status}=${r.n}`).join(', '));

// ---- the device's screen list matches the school's people ----
const people = await q(`SELECT device_user_id FROM school.people WHERE school_id=$1 AND is_active AND device_user_id IS NOT NULL`, [seedMod.IDS.A.school]);
const missing = people.map((p) => p.device_user_id).filter((pin) => !devA.users.has(pin));
check("every school-A person with a device ID is on school A's device", missing.length === 0, missing.length ? 'missing ' + missing.join(',') : `${people.length} people`);

// ---- other school ----
await devB.drain();
const leak = [...devB.users.values()].filter((u) => /A-SECRET|Nakato|Okello|Zoë|Auma|Ssekandi/.test(u.name || ''));
check("school B's device never receives school A's names", leak.length === 0, leak.length ? JSON.stringify(leak) : `B device has ${devB.users.size} entries`);

await db.end();
console.log('\nschool A device screen list:');
for (const [pin, u] of [...devA.users.entries()].sort()) console.log(`  ${pin.padEnd(5)} ${u.name}  (Pri ${u.pri})`);
console.log(failures ? `\n${failures} FAILED` : '\nDEVICE NAME PUSH: ALL CHECKS OK');
process.exit(failures ? 1 : 0);
