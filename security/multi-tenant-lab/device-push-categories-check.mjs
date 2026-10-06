// Device page "push names" options, end to end: Teachers, Support staff,
// All students, One class (streams are classes, e.g. "S.2 East" / "S.2 West"),
// Everyone; plus "Auto-assign IDs + push" per option, the preview list, and
// tenant boundaries. A simulated ZKTeco terminal polls the real app.
// Usage: node device-push-categories-check.mjs <base> <appDir> [selection.json]
//   OLD_COMPAT=1: terminal also accepts long ids / lowercase userinfo (to run on old code)
import pg from 'pg';
import fs from 'fs';
import { execSync } from 'child_process';
import { setupUsers, sessionCookie, actionIds, callAction, SHIM } from './lib.mjs';
import seedMod from './seed.js';
const [BASE = 'http://127.0.0.1:3201', APPDIR = '/home/user/schoolmnt2', OUT] = process.argv.slice(2);
const OLD = process.env.OLD_COMPAT === '1';
const SECRETS = { SNA0001: 'A-device-secret-0123456789', SNB0001: 'B-device-secret-9876543210' };
const A = seedMod.IDS.A.school, B = seedMod.IDS.B.school;

execSync('node seed.js', { cwd: '/home/user/mt-lab' });
const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

// ---------- a realistic school ----------
const cls = async (school, name) => (await q(`INSERT INTO school.classes(school_id,name) VALUES ($1,$2) RETURNING id`, [school, name]))[0].id;
const EAST = await cls(A, 'S.2 East'), WEST = await cls(A, 'S.2 West'), P5 = await cls(A, 'P.5');
const B_EAST = await cls(B, 'S.2 East');                 // same stream name, other school
const person = (school, name, role, pin, classId = null, active = true) =>
  q(`INSERT INTO school.people(school_id,full_name,role,device_user_id,class_id,is_active) VALUES ($1,$2,$3,$4,$5,$6)`, [school, name, role, pin, classId, active]);
await person(A, 'Akello Mary', 'student', '301', EAST);
await person(A, 'Opio John', 'student', '302', EAST);
await person(A, 'Kato Nopin', 'student', null, EAST);          // no device ID yet
await person(A, 'Nambi Ruth', 'student', '311', WEST);
await person(A, 'Mugisha Paul', 'student', '312', WEST);
await person(A, 'Left Student', 'student', '313', WEST, false); // left the school
await person(A, 'Achan Grace', 'student', '321', P5);
await person(A, 'Okot Peter', 'teacher', '401');
await person(A, 'Head Admin', 'admin', '402');
await person(A, 'Wasswa Guard', 'support_staff', '501');
await person(A, 'Cook Nansubuga', 'support_staff', null);       // no device ID yet
await person(B, 'Bstudent Zed', 'student', '601', B_EAST);
await fetch(SHIM + '/__reload', { method: 'POST' });

await setupUsers();
const ids = actionIds(APPDIR);
const ck = await sessionCookie('adminA@lab.io');
const act = async (n, args) => { const a = ids[n][0]; return (await callAction(BASE, '/' + a.page.replace(/^app\//, '').replace(/\/page$/, ''), a.id, args, ck)).value; };

let failures = 0;
const check = (name, pass, detail = '') => { if (!pass) failures++; console.log(`${pass ? 'OK    ' : 'FAILED'} ${name}${detail ? '  [' + detail + ']' : ''}`); };
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

class Terminal {
  constructor(sn) { this.sn = sn; this.users = new Map(); this.rejected = []; }
  async poll() {
    const qs = new URLSearchParams({ SN: this.sn, token: SECRETS[this.sn] });
    const body = await (await fetch(`${BASE}/iclock/getrequest?${qs}`)).text();
    if (body.trim() === 'OK') return 0;
    const replies = []; let n = 0;
    for (const line of body.split('\n')) {
      const m = /^C:([^:]*):(.*)$/.exec(line); if (!m) continue;
      const [, id, cmd] = m; n++;
      if (!OLD && !/^[A-Za-z0-9]{1,16}$/.test(id)) { this.rejected.push('bad id'); continue; }
      const d = new RegExp('^DATA (UPDATE|DELETE) USERINFO (.*)$', OLD ? 'i' : '').exec(cmd);
      if (!d) { this.rejected.push(cmd.slice(0, 30)); replies.push(`ID=${id}&Return=-1002&CMD=DATA`); continue; }
      const f = Object.fromEntries(d[2].split('\t').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
      if (d[1].toUpperCase() === 'UPDATE') this.users.set(f.PIN, { name: f.Name, pri: f.Pri }); else this.users.delete(f.PIN);
      replies.push(`ID=${id}&Return=0&CMD=DATA`);
    }
    if (replies.length) await fetch(`${BASE}/iclock/devicecmd?${qs}`, { method: 'POST', body: replies.join('\n') + '\n' });
    return n;
  }
  async drain() { for (let i = 0; i < 20; i++) if (!(await this.poll())) break; }
}
await new Terminal('SNA0001').drain(); await new Terminal('SNB0001').drain();

const selection = {};   // what each option picks: compared between old and new code
const options = [
  ['Teachers (incl. admins)', { category: 'teachers' }, ['101', '401', '402']],
  ['Support staff', { category: 'support_staff' }, ['501']],
  ['All students', { category: 'all_students' }, ['102', '301', '302', '311', '312', '321']],
  ['Stream S.2 East', { category: 'class', classId: EAST }, ['301', '302']],
  ['Stream S.2 West', { category: 'class', classId: WEST }, ['311', '312']],
  ['Class P.5', { category: 'class', classId: P5 }, ['321']],
  ['Everyone', { category: 'all' }, ['101', '102', '301', '302', '311', '312', '321', '401', '402', '501']],
];

for (const [label, opt, expected] of options) {
  await q('DELETE FROM school.device_commands');
  const dev = new Terminal('SNA0001');
  const preview = await act('getDevicePushCandidatesAction', [{ deviceSerialNumber: 'SNA0001', ...opt }]);
  const res = await act('pushUsersToDeviceAction', [{ deviceSerialNumber: 'SNA0001', ...opt }]);
  await dev.drain();
  const onScreen = [...dev.users.keys()];
  const queued = (await q(`SELECT raw_command FROM school.device_commands`)).map((r) => /PIN=([^\t]*)/.exec(r.raw_command)?.[1]);
  const previewPins = (preview?.candidates || []).filter((c) => c.device_user_id).map((c) => c.device_user_id);
  selection[label] = { queued: [...queued].sort(), preview: [...previewPins].sort(), total: preview?.totalCount, withPin: preview?.withPinCount, withoutPin: preview?.withoutPinCount, count: res?.count };
  check(`${label}: device shows exactly the right people`, same(onScreen, expected), `screen ${onScreen.sort().join(',')}`);
  check(`${label}: preview list = what was pushed`, same(previewPins, expected), `preview ${previewPins.length}, pushed ${res?.count}`);
  if (!OLD) {
    const nameMismatch = (preview?.candidates || []).filter((c) => c.device_user_id && dev.users.get(c.device_user_id)?.name !== c.formattedName);
    check(`${label}: names on device = names in the preview`, nameMismatch.length === 0, nameMismatch.map((c) => `${c.formattedName} vs ${dev.users.get(c.device_user_id)?.name}`).join(' | '));
  }
  const pri = [...dev.users.entries()].filter(([pin, u]) => u.pri !== (pin === '402' ? '14' : '0'));
  check(`${label}: device rights unchanged (admin 14, everyone else 0)`, pri.length === 0, pri.map(([p, u]) => `${p}=${u.pri}`).join(','));
  check(`${label}: every command accepted`, dev.rejected.length === 0, dev.rejected.slice(0, 2).join(' | '));
}

// specific names (streams shown with the person)
{
  await q('DELETE FROM school.device_commands');
  const dev = new Terminal('SNA0001');
  await act('pushUsersToDeviceAction', [{ deviceSerialNumber: 'SNA0001', category: 'all' }]);
  await dev.drain();
  const n = (p) => dev.users.get(p)?.name;
  if (!OLD) check('screen names: "Akello Mary (S.2 East)", "Nambi Ruth (S.2 West)", "Tr. Okot Peter", "Adm. Head Admin", "Stf. Wasswa Guard"',
    n('301') === 'Akello Mary (S.2 East)' && n('311') === 'Nambi Ruth (S.2 West)' && n('401') === 'Tr. Okot Peter' && n('402') === 'Adm. Head Admin' && n('501') === 'Stf. Wasswa Guard',
    ['301', '311', '401', '402', '501'].map(n).join(' | '));
}

// tenant + bad input
{
  const r1 = await act('pushUsersToDeviceAction', [{ deviceSerialNumber: 'SNA0001', category: 'class', classId: B_EAST }]);
  const r2 = await act('pushUsersToDeviceAction', [{ deviceSerialNumber: 'SNB0001', category: 'all' }]);
  const r3 = await act('getDevicePushCandidatesAction', [{ deviceSerialNumber: 'SNA0001', category: 'class', classId: B_EAST }]);
  const r4 = await act('autoAssignDevicePinsAction', [{ deviceSerialNumber: 'SNA0001', category: 'class', classId: B_EAST }]);
  check("other school's stream (same name 'S.2 East') refused on push / preview / auto-assign", !!r1?.error && !!r3?.error && !!r4?.error, [r1?.error, r3?.error, r4?.error].join(' / '));
  check("other school's device refused", !!r2?.error, r2?.error);
  const bdev = new Terminal('SNB0001'); await bdev.drain();
  check("school B's device received nothing from school A", bdev.users.size === 0, `${bdev.users.size} entries`);
}

// auto-assign per option: only the chosen group gets new IDs
{
  await q('DELETE FROM school.device_commands');
  const dev = new Terminal('SNA0001');
  const r = await act('autoAssignDevicePinsAction', [{ deviceSerialNumber: 'SNA0001', category: 'class', classId: EAST }]);
  await dev.drain();
  const pins = Object.fromEntries((await q(`SELECT full_name, device_user_id FROM school.people WHERE full_name IN ('Kato Nopin','Cook Nansubuga')`)).map((x) => [x.full_name, x.device_user_id]));
  selection['auto-assign S.2 East'] = { assigned: Object.keys(pins).filter((k) => pins[k]).sort(), count: r?.count };
  check('auto-assign on stream S.2 East: only Kato (East, no ID) gets an ID', !!pins['Kato Nopin'] && !pins['Cook Nansubuga'], JSON.stringify(pins));
  check('auto-assign on stream S.2 East: device shows only Kato', same(dev.users.keys(), [pins['Kato Nopin']]) && /Kato Nopin/.test(dev.users.get(pins['Kato Nopin'])?.name || ''), [...dev.users.values()].map((u) => u.name).join(','));

  await q('DELETE FROM school.device_commands');
  const dev2 = new Terminal('SNA0001');
  await act('autoAssignDevicePinsAction', [{ deviceSerialNumber: 'SNA0001', category: 'support_staff' }]);
  await dev2.drain();
  const cook = (await q(`SELECT device_user_id FROM school.people WHERE full_name='Cook Nansubuga'`))[0].device_user_id;
  check('auto-assign on support staff: cook gets a new, unused ID and shows on device', !!cook && !['301', '302', '311', '312', '313', '321', '401', '402', '501', pins['Kato Nopin']].includes(cook) && /Cook Nansubuga/.test(dev2.users.get(cook)?.name || ''), `ID ${cook}, screen ${dev2.users.get(cook)?.name}`);
  const r2 = await act('autoAssignDevicePinsAction', [{ deviceSerialNumber: 'SNA0001', category: 'all' }]);
  check('auto-assign when everyone already has an ID: nothing changes', r2?.count === 0, r2?.message);
}

// "One class" chosen but no class given (e.g. a school with no classes yet)
{
  await q(`INSERT INTO school.people(school_id,full_name,role,is_active) VALUES ($1,'Nopin Teacher','teacher',true)`, [A]);
  await q('DELETE FROM school.device_commands');
  const p = await act('pushUsersToDeviceAction', [{ deviceSerialNumber: 'SNA0001', category: 'class' }]);
  const a = await act('autoAssignDevicePinsAction', [{ deviceSerialNumber: 'SNA0001', category: 'class' }]);
  const t = (await q(`SELECT device_user_id FROM school.people WHERE full_name='Nopin Teacher'`))[0].device_user_id;
  selection['class without classId'] = { push: p?.error ? 'refused' : `pushed ${p?.count}`, autoAssignTouchedTeacher: !!t };
  check('"One class" with no class picked never gives a TEACHER an ID / pushes staff', !t, `push: ${p?.error || 'pushed ' + p?.count}; auto-assign: ${a?.error || a?.message}; teacher ID now ${t}`);
}

await db.end();
if (OUT) fs.writeFileSync(OUT, JSON.stringify(selection, null, 2));
console.log(failures ? `\n${failures} FAILED` : '\nPUSH BY CATEGORY / CLASS / STREAM: ALL CHECKS OK');
process.exit(failures ? 1 : 0);
