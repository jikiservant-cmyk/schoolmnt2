// Real user flows: log in through the login form, then check every page shows
// the RIGHT content (not just HTTP 200). Usage: node flows-check.mjs <base> <appDir>
import { setupUsers, actionIds, callAction } from './lib.mjs';
const [BASE = 'http://127.0.0.1:3201', APPDIR = '/home/user/schoolmnt2'] = process.argv.slice(2);
await setupUsers();
const problems = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok     ' : 'PROBLEM'} ${name}${detail ? '  [' + detail + ']' : ''}`); if (!ok) problems.push(name + (detail ? ' [' + detail + ']' : '')); };
const ids = actionIds(APPDIR);
const loginId = ids.loginAction?.[0]?.id;
if (!loginId) { console.log('loginAction id not found: open /login once (warm.mjs) and retry'); process.exit(1); }

async function login(email, password) {
  const fd = new FormData(); fd.append('email', email); fd.append('password', password);
  const fdBody = new FormData();
  for (const [k, v] of fd.entries()) fdBody.append('_1_' + k, v);
  fdBody.append('0', JSON.stringify(['$K1']));
  const r = await fetch(BASE + '/login', { method: 'POST', body: fdBody, headers: { 'Next-Action': loginId, Accept: 'text/x-component', Origin: BASE }, redirect: 'manual' });
  const text = await r.text();
  const cookies = (r.headers.getSetCookie?.() || []).filter((c) => c.startsWith('sb-') && !/max-age=0/i.test(c)).map((c) => c.split(';')[0]);
  const redirect = r.headers.get('x-action-redirect') || r.headers.get('location') || '';
  return { status: r.status, text, cookie: cookies.join('; '), redirect };
}
const page = async (path, cookie) => {
  const r = await fetch(BASE + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location'), html: r.status === 200 ? await r.text() : '' };
};

// 1. Login form
const good = await login('adminA@lab.io', 'Passw0rd!');
check('admin logs in with the right password -> sent to /dashboard', !!good.cookie && good.redirect.includes('/dashboard'), `status ${good.status}, redirect "${good.redirect}", session ${good.cookie ? 'set' : 'MISSING'}`);
const bad = await login('adminA@lab.io', 'wrong-password-1');
check('wrong password -> stays on login with an error, no session', !bad.cookie && !bad.redirect && /Invalid|incorrect|error/i.test(bad.text), `status ${bad.status}`);
const tch = await login('teacherA@lab.io', 'Passw0rd!');
check('teacher (not an admin) cannot log into the admin dashboard', !tch.redirect.includes('/dashboard') || !tch.cookie, `redirect "${tch.redirect}", session ${tch.cookie ? 'set' : 'none'}`);

// 2. Every page shows the right content for the logged-in admin
const ck = good.cookie;
// Server-rendered content each sidebar link must land on (exact page, right school).
const expectations = [
  ['/dashboard', ['Alpha Academy'], 'dashboard shows the school'],
  ['/dashboard/people?role=student', ['Total Students', 'initialRoleFilter\\":\\"student'], 'Students link opens People filtered to students'],
  ['/dashboard/people?role=teacher', ['Total Students', 'initialRoleFilter\\":\\"teacher'], 'Teachers link opens People filtered to teachers'],
  ['/dashboard/people', ['Total Students', 'initialRoleFilter\\":\\"all'], 'People page opens unfiltered'],
  ['/dashboard/classes', ['Class A-SECRETNAME'], 'Classes page lists the school class'],
  ['/dashboard/attendance', ['Attendance &amp; SMS Logs'], 'Attendance page opens'],
  ['/dashboard/devices', ['SNA0001'], 'Devices page lists the school device'],
  ['/mark-attendance', ['Biometric Clock-In'], 'Kiosk page opens'],
  ['/manual-attendance/aaaaaaaa-0000-4000-8000-0000000000c1', ['Teacher PIN'], 'Class register link opens the PIN screen'],
];
for (const [path, needles, name] of expectations) {
  const r = await page(path, ck);
  const missing = needles.filter((n) => !r.html.includes(n));
  const leak = r.html.includes('B-SECRETNAME');
  check(`${name} (${path})`, r.status === 200 && missing.length === 0 && !leak, r.status !== 200 ? `HTTP ${r.status} -> ${r.location}` : missing.length ? 'missing: ' + missing.join(', ') : leak ? "shows another school's data" : '');
}

// Sidebar Students -> Teachers is a client-side navigation: the People list
// must be re-keyed by role, or React keeps the old filter (bug fixed launch eve).
for (const role of ['student', 'teacher']) {
  const r = await fetch(BASE + '/dashboard/people?role=' + role, { headers: { cookie: ck, RSC: '1' } });
  const t = await r.text();
  check(`sidebar click to ${role}s re-keys the People list`, new RegExp(`\\["\\$","\\$L[0-9a-f]+","${role}",\\{"classes"`).test(t));
}

// Data the pages load from the browser after opening (same calls the UI makes).
const act = (name) => ids[name]?.[0]?.id;
const call = (path, name, args) => callAction(BASE, path, act(name), args, ck);
const str = (v) => JSON.stringify(v ?? null);
// Flight encodes `undefined` as the string "$undefined".
const hasErr = (v) => v && v.error && v.error !== '$undefined';
{
  const stu = await call('/dashboard/people?role=student', 'searchPeopleAction', [{ searchTerm: '', roleFilter: 'student', statusFilter: 'all', page: 1, limit: 25 }]);
  check('Students list shows the student and no teachers', str(stu.value).includes('Student A-SECRETNAME') && !str(stu.value).includes('Teacher A-SECRETNAME') && !str(stu.value).includes('B-SECRETNAME'), `HTTP ${stu.status}`);
  const tea = await call('/dashboard/people?role=teacher', 'searchPeopleAction', [{ searchTerm: '', roleFilter: 'teacher', statusFilter: 'all', page: 1, limit: 25 }]);
  check('Teachers list shows the teacher and no students', str(tea.value).includes('Teacher A-SECRETNAME') && !str(tea.value).includes('Student A-SECRETNAME'), `HTTP ${tea.status}`);
  const att = await call('/dashboard/attendance', 'getAttendanceData', []);
  check('Attendance page data loads for this school only', att.status === 200 && att.value && !hasErr(att.value) && !str(att.value).includes('B-SECRETNAME'), `HTTP ${att.status} ${str(att.value).slice(0, 120)}`);
  const bal = await call('/dashboard/attendance', 'getSchoolBalance', []);
  check('SMS balance loads', bal.status === 200 && bal.value && typeof (bal.value.balance ?? bal.value) !== 'undefined' && !hasErr(bal.value), `HTTP ${bal.status} ${str(bal.value).slice(0, 120)}`);
  const kiosk = await call('/mark-attendance', 'getPeopleWithDeviceIds', []);
  check('Kiosk lists this school\'s enrolled users only', Array.isArray(kiosk.value) && kiosk.value.length > 0 && !str(kiosk.value).includes('B-SECRETNAME'), `${str(kiosk.value).slice(0, 120)}`);
  const ct = await call('/manual-attendance/aaaaaaaa-0000-4000-8000-0000000000c1', 'getTeachersForClass', ['aaaaaaaa-0000-4000-8000-0000000000c1']);
  check('Class register lists the class teacher to pick', str(ct.value).includes('Teacher A-SECRETNAME'), `${str(ct.value).slice(0, 120)}`);
  const ctB = await call('/manual-attendance/bbbbbbbb-0000-4000-8000-0000000000c1', 'getTeachersForClass', ['bbbbbbbb-0000-4000-8000-0000000000c1']);
  check("another school's class register shows none of its teachers", !str(ctB.value).includes('B-SECRETNAME'), `${str(ctB.value).slice(0, 120)}`);
  const sB = await call('/manual-attendance/bbbbbbbb-0000-4000-8000-0000000000c1', 'getStudentsForClass', ['bbbbbbbb-0000-4000-8000-0000000000c1']);
  check("another school's class students are not readable", !str(sB.value).includes('B-SECRETNAME'), `${str(sB.value).slice(0, 120)}`);
}

// 3. Bad / foreign links fail gracefully (no crash page)
for (const [path, name] of [
  ['/manual-attendance/bbbbbbbb-0000-4000-8000-0000000000c1', "another school's class register link"],
  ['/manual-attendance/not-a-real-id', 'garbage class register link'],
  ['/dashboard/nonexistent', 'unknown dashboard page'],
]) {
  const r = await page(path, ck);
  const crashed = r.status >= 500 || /Application error|Unhandled Runtime Error/.test(r.html);
  check(`${name} handled cleanly (${path})`, !crashed && !r.html.includes('B-SECRETNAME'), `HTTP ${r.status}`);
}
console.log(`\n${problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'ALL FLOWS OK'}`);
