// Multi-tenant attack suite: tenant A's admin attacks tenant B.
// Usage: node attack.mjs <base> <appDir> <label>
import pg from 'pg';
import { execSync } from 'child_process';
import { setupUsers, sessionCookie, actionIds, callAction, SHIM } from './lib.mjs';
import seedMod from './seed.js';
const { IDS, SECRETS } = seedMod;
const [BASE, APPDIR, LABEL] = process.argv.slice(2);
const A = IDS.A, B = IDS.B;
const results = [];
const rec = (name, vulnerable, detail) => { results.push({ name, vulnerable, detail }); console.log((vulnerable ? 'VULNERABLE ' : 'secure     ') + name + (detail ? '  [' + String(detail).slice(0, 160) + ']' : '')); };

execSync('node seed.js', { cwd: '/home/user/mt-lab' });
await fetch(SHIM + '/__reload', { method: 'POST' });
await setupUsers();
const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const one = async (sql, p) => (await db.query(sql, p)).rows;
const cookieA = await sessionCookie('adminA@lab.io');
const ids = actionIds(APPDIR);
const act = async (name, args) => {
  const a = ids[name][0];
  const page = '/' + a.page.replace(/^app\//, '').replace(/\/page$/, '').replace('[classId]', A.cls);
  const r = await callAction(BASE, page, a.id, args, cookieA);
  return r;
};
const fd = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const shimLog = async () => (await (await fetch(SHIM + '/__log')).json());
const has = (r, s) => JSON.stringify(r.value ?? r.text).includes(s);
const short = (r) => JSON.stringify(r.value ?? r.text.slice(0, 200));

// 1. addPerson: student into B's class
{
  const r = await act('addPersonAction', [fd({ fullName: 'Mole Student', role: 'student', classId: B.cls })]);
  const rows = await one("SELECT id FROM school.people WHERE school_id=$1 AND class_id=$2", [A.school, B.cls]);
  rec('addPerson: A enrols a student into B\'s class', rows.length > 0, short(r));
}
// 2. addPerson: teacher assigned to B's class (passed to fn_add_person)
{
  await shimLog();
  const r = await act('addPersonAction', [fd({ fullName: 'Mole Teacher', role: 'teacher', phone: '+256700000009', classIdsJson: JSON.stringify([B.cls]) })]);
  const log = await shimLog();
  const passed = log.some((l) => l.startsWith('RPC fn_add_person') && l.includes(B.cls));
  rec('addPerson: A assigns a new teacher to B\'s class (sent to fn_add_person)', passed, short(r));
}
// 3. addClass with B's teacher
{
  const r = await act('addClassAction', [fd({ name: 'Hijack', teacherId: B.teacher })]);
  const rows = await one("SELECT id FROM school.classes WHERE school_id=$1 AND teacher_id=$2", [A.school, B.teacher]);
  rec('addClass: A creates a class taught by B\'s teacher', rows.length > 0, short(r));
}
// 4. recordTeacherAttendance on B's teacher
{
  const r = await act('recordTeacherAttendance', [B.teacher, 'present']);
  const rows = await one("SELECT id FROM school.attendance_logs WHERE person_id=$1", [B.teacher]);
  rec('recordTeacherAttendance: A marks B\'s teacher present', rows.length > 0, short(r));
}
// 4b. bogus status
{
  const r = await act('recordTeacherAttendance', [A.teacher, 'absent_hacked']);
  const rows = await one("SELECT id FROM school.attendance_logs WHERE status='absent_hacked'");
  rec('recordTeacherAttendance: arbitrary status value stored', rows.length > 0, short(r));
}
// 5. updatePersonDeviceUserId on B's student
{
  const r = await act('updatePersonDeviceUserIdAction', [B.student, '777']);
  const rows = await one("SELECT device_user_id FROM school.people WHERE id=$1", [B.student]);
  rec('updatePersonDeviceUserId: A rewrites B student\'s biometric ID', rows[0].device_user_id === '777', short(r));
}
// 6. resetTeacherPin on B's teacher
{
  const before = (await one("SELECT pin_hash FROM school.staff_users WHERE person_id=$1", [B.teacher]))[0].pin_hash;
  const r = await act('resetTeacherPinAction', [B.teacher]);
  const after = (await one("SELECT pin_hash FROM school.staff_users WHERE person_id=$1", [B.teacher]))[0].pin_hash;
  rec('resetTeacherPin: A resets (and learns) B teacher\'s PIN', before !== after || /\b\d{6}\b/.test(JSON.stringify(r.value || '')), short(r));
}

// 7. push candidates for B's class: leaks class name?
{
  const r = await act('getDevicePushCandidatesAction', [{ category: 'class', classId: B.cls }]);
  rec('getDevicePushCandidates: B class name / students leak to A', has(r, 'B-SECRETNAME'), short(r));
}
const cmdCount = async () => (await one("SELECT count(*)::int n FROM school.device_commands WHERE device_id=$1 OR upper(target_serial)='SNB0001' OR (school_id=$2 AND target_serial<>'SNA0001')", [B.device, B.school]))[0].n;
const foreignCmds = async () => (await one("SELECT count(*)::int n FROM school.device_commands WHERE school_id=$1 AND (device_id=$2 OR upper(target_serial)<>'SNA0001')", [A.school, B.device]))[0].n
  + (await one("SELECT count(*)::int n FROM school.device_commands WHERE school_id=$1 AND raw_command NOT LIKE '%B-SECRETCMD%'", [B.school]))[0].n
  + (await one("SELECT count(*)::int n FROM school.device_logs WHERE serial_number IS NOT NULL AND upper(serial_number)='SNB0001'"))[0].n;
// 8. push users to B's device (various serial spellings / wildcards)
for (const sn of ['SNB0001', 'snb0001', '%', 'SN_0001', 'SNB%']) {
  const before = await cmdCount();
  const f0 = await foreignCmds();
  const r = await act('pushUsersToDeviceAction', [{ deviceSerialNumber: sn, category: 'all' }]);
  const after = await cmdCount();
  const f1 = await foreignCmds();
  rec(`pushUsersToDevice serial=${JSON.stringify(sn)}: A queues commands onto B's device`, after > before || f1 > f0, short(r));
}
// 9. push with B's class as filter (enumeration oracle via class lookup)
{
  const r = await act('pushUsersToDeviceAction', [{ deviceSerialNumber: 'SNA0001', category: 'class', classId: B.cls }]);
  rec('pushUsersToDevice class=B: B class accepted / named in reply', has(r, 'B-SECRETNAME') || (r.value && r.value.success === true), short(r));
}
// 10. autoAssign onto B's device
{
  const before = await cmdCount();
  const r = await act('autoAssignDevicePinsAction', [{ deviceSerialNumber: 'SNB0001', category: 'all' }]);
  const after = await cmdCount();
  rec('autoAssignDevicePins: A pushes PINs onto B\'s device', after > before, short(r));
}
// 11. pushAll onto B's device
{
  const before = await cmdCount();
  const r = await act('pushAllUsersToDeviceAction', ['SNB0001']);
  const after = await cmdCount();
  rec('pushAllUsersToDevice: A pushes everyone onto B\'s device', after > before, short(r));
}
// 12. regenerate B's device secret
{
  const q = "SELECT device_secret_hash h FROM school.devices WHERE id=$1";
  const before = (await one(q, [B.device]))[0].h;
  const r = await act('regenerateDeviceSecretAction', [B.device]);
  const after = (await one(q, [B.device]))[0].h;
  rec('regenerateDeviceSecret: A rotates B device secret (takeover / DoS)', before !== after, short(r));
}
// 13. addDevice with B's serial: enumeration message
{
  const r = await act('addDeviceAction', [fd({ serialNumber: 'SNB0001', label: 'x', deviceType: 'zkteco_adms' })]);
  rec('addDevice: error reveals serial belongs to another school', /another school|other school|different school/i.test(JSON.stringify(r.value || '')), short(r));
}
// 14. getStudentsForClass(B)
{
  const r = await act('getStudentsForClass', [B.cls]);
  rec('getStudentsForClass: A reads B class roster', has(r, 'B-SECRETNAME'), short(r));
}
// 15. submitClassAttendance with A class + A teacher PIN but B student
{
  const r = await act('submitClassAttendance', [A.cls, A.teacher, [B.student], [], 'check_in', '482913']);
  const rows = await one("SELECT id FROM school.attendance_logs WHERE person_id=$1", [B.student]);
  rec('submitClassAttendance: A logs attendance for B student', rows.length > 0, short(r));
}
// 16. kiosk clock-in with B student's device id
{
  const r = await act('submitClockInAction', ['202']);
  const rows = await one("SELECT id FROM school.attendance_logs WHERE person_id=$1", [B.student]);
  rec('submitClockIn: A kiosk clocks in B student (device id 202)', rows.length > 0, short(r));
}
// 17. search injection
for (const term of ['x,school_id.neq.null', 'B-SECRETNAME', '*)', 'a%']) {
  const r = await act('searchPeopleAction', [{ searchTerm: term, page: 1, limit: 50 }]);
  rec(`searchPeople term=${JSON.stringify(term)}: B rows returned`, has(r, 'B-SECRETNAME') || has(r, B.school), short(r).slice(0, 120));
}
// 18. attendance data / dashboards
{
  const r = await act('getAttendanceData', []);
  rec('getAttendanceData: B rows visible to A', has(r, 'B-SECRETNAME'), '');
  for (const p of ['/dashboard', '/dashboard/people', '/dashboard/classes', '/dashboard/devices', '/dashboard/attendance']) {
    const html = await (await fetch(BASE + p, { headers: { cookie: cookieA } })).text();
    rec(`page ${p}: contains B data`, html.includes('B-SECRETNAME') || html.includes('SNB0001'), '');
  }
}
// 19. Device protocol (iclock) - per-device secret enforcement
const ic = (path, qs, body) => fetch(BASE + path + '?' + new URLSearchParams(qs), body ? { method: 'POST', body } : {});
{
  const r = await ic('/iclock/cdata', { SN: 'SNB0001', token: SECRETS.A });
  rec('iclock: B serial accepted with A\'s per-device secret', r.status === 200, r.status);
  const r2 = await ic('/iclock/cdata', { SN: 'SNA0001', token: SECRETS.A });
  rec('iclock (baseline): A serial + A secret is accepted', r2.status !== 200, r2.status);
  const r3 = await ic('/iclock/cdata', { SN: 'SNB0001', token: 'GLOBAL-shared-secret-123456' });
  rec('iclock: B device accepted with GLOBAL shared secret (transition mode allows; strict mode must not)', r3.status === 200, r3.status + ' (expected 200 while ZKTECO_GLOBAL_SECRET_FALLBACK unset)');
}
// 20. ATTLOG injection: B's person id punched on B's device using A's secret
{
  const r = await ic('/iclock/cdata', { SN: 'SNB0001', table: 'ATTLOG', token: SECRETS.A }, '202\t2026-10-05 07:30:00\t0\t1\n');
  const rows = await one("SELECT id FROM school.attendance_logs WHERE person_id=$1 AND source IS DISTINCT FROM 'manual'", [B.student]);
  rec('iclock ATTLOG: A forges attendance for B student on B device', rows.length > 0, r.status);
}
// 21. ATTLOG on A's device with B's enrolment id
{
  const r = await ic('/iclock/cdata', { SN: 'SNA0001', table: 'ATTLOG', token: SECRETS.A }, '202\t2026-10-05 07:31:00\t0\t1\n');
  const rows = await one("SELECT id FROM school.attendance_logs WHERE person_id=$1", [B.student]);
  rec('iclock ATTLOG: A device punch resolves to B student', rows.length > 0, r.status);
}
// 22. getrequest returns only own commands
{
  const t = await (await ic('/iclock/getrequest', { SN: 'SNA0001', token: SECRETS.A })).text();
  rec('iclock getrequest (A): leaks B commands', t.includes('B-SECRETCMD'), t.slice(0, 100).replace(/\s+/g, ' '));
  const r = await ic('/iclock/getrequest', { SN: 'SNB0001', token: SECRETS.A });
  const t2 = await r.text();
  rec('iclock getrequest: A pulls B queue with own secret', t2.includes('B-SECRETCMD'), r.status);
}
// 23. Payment webhook tenant resolution
import crypto from 'crypto';
const hook = async (payload) => {
  const body = JSON.stringify(payload);
  // Signed exactly like najiki-finance2 buildNotificationHeaders(): t=<ms>,v=HMAC("<t>.<body>")
  const t = Date.now();
  const sig = crypto.createHmac('sha256', process.env.NAJIKI_WEBHOOK_SECRET || 'lab-najiki-secret').update(`${t}.${body}`).digest('hex');
  const r = await fetch(BASE + '/api/webhooks/najiki', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-najiki-timestamp': String(t), 'x-najiki-signature': `t=${t},v=${sig}` } });
  return { status: r.status, body: await r.text() };
};
const bal = async (s) => Number((await one("SELECT balance FROM public.wallets WHERE tenant_id=$1", [s]))[0]?.balance ?? 0);
{
  const b0 = await bal(B.school), a0 = await bal(A.school);
  // A pays, but payload carries B's tenant code first and A's uuid in metadata.
  const r = await hook({ status: 'SUCCESS', amount: 500, reference: 'ref-1', tenantCode: 'codeB', metadata: { schoolId: A.school } });
  const b1 = await bal(B.school), a1 = await bal(A.school);
  rec('webhook: A\'s top-up credited to B (tenant code beats school uuid)', b1 > b0 || (process.env.MIG05 === '0' && a1 === a0), `${r.status} A ${a0}->${a1} B ${b0}->${b1}`);
}
{
  const a0 = await bal(A.school);
  const r1 = await hook({ status: 'SUCCESS', amount: 700, schoolId: A.school });
  const r2 = await hook({ status: 'SUCCESS', amount: 700, schoolId: A.school });
  const a1 = await bal(A.school);
  rec('webhook: missing reference -> replay double-credits', a1 - a0 > 700, `${r1.status}/${r2.status} A ${a0}->${a1}`);
}
{
  const r = await hook({ status: 'SUCCESS', amount: 500, reference: 'ref-x', schoolId: 'x),school_id.neq.null' });
  rec('webhook: filter injection via schoolId accepted', r.status === 200, r.status + ' ' + r.body.slice(0, 100));
  const r2 = await hook({ status: 'SUCCESS', amount: 500, reference: 'ref-y', schoolId: A.school, school_id: B.school });
  rec('webhook: conflicting school ids accepted', r2.status === 200, r2.status + ' ' + r2.body.slice(0, 100));
}

await db.end();
const vuln = results.filter((r) => r.vulnerable).length;
console.log(`\n[${LABEL}] ${vuln} vulnerable / ${results.length} checks`);
import fs from 'fs';
fs.writeFileSync(`/home/user/mt-lab/results-${LABEL}.json`, JSON.stringify(results, null, 2));
