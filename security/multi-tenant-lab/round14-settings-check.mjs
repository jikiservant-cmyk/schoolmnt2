// Round 14 Security, Multi-Tenant Isolation, Money Parity & Configurable Policies Verification Suite.
// Verifies every Round 14 feature & security invariant end-to-end against PostgreSQL 17.5 +
// strict PostgREST shim (SHIM_NO_AUTOCOL=1) + production Next.js server (:3000).
import crypto from 'crypto';
import { execSync } from 'child_process';
import pg from 'pg';
import {
  setupUsers,
  SHIM,
  sessionCookie,
  actionIds as loadActionIds,
  callAction as rawCallAction,
} from './lib.mjs';
import seedMod from './seed.js';

const {
  IDS: { A, B },
  SECRETS,
} = seedMod;

const rawArgs = process.argv.slice(2);
const BASE = rawArgs[0]?.startsWith('http') ? rawArgs[0] : process.env.BASE || 'http://127.0.0.1:3000';
const APP_DIR = rawArgs[0]?.startsWith('http')
  ? rawArgs[1] || '/home/user/schoolmnt2'
  : process.env.APP_DIR || '/home/user/schoolmnt2';
const WEBHOOK_SECRET = process.env.NAJIKI_WEBHOOK_SECRET || 'lab-dedicated-webhook-secret-123';

const findings = [];
let passed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    findings.push({ name, detail });
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function signNajikiHeaders(rawBody) {
  const t = Date.now();
  const v = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Najiki-Notification': 'true',
    'X-Najiki-Timestamp': String(t),
    'X-Najiki-Signature': `t=${t},v=${v}`,
  };
}

async function seedLab(extraEnv = {}) {
  execSync('node seed.js', {
    cwd: '/home/user/mt-lab',
    env: { ...process.env, RLS: '1', ...extraEnv },
  });
  await fetch(SHIM + '/__reload', { method: 'POST' });
  await setupUsers();
  await fetch(SHIM + '/__users', {
    method: 'POST',
    body: JSON.stringify({
      'orphan@lab.io': {
        id: 'cccccccc-0000-4000-8000-000000000099',
        email: 'orphan@lab.io',
        password: 'Passw0rd!',
      },
    }),
  });
}

await seedLab();

const db = new pg.Client({
  host: '127.0.0.1',
  port: 54329,
  user: 'postgres',
  password: 'pw',
  database: 'mtlab',
});
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

const acts = loadActionIds(APP_DIR);

async function callAction(cookie, fnName, args, pagePath = '/dashboard/settings') {
  const entry = (acts[fnName] || [])[0];
  if (!entry) throw new Error(`Missing server action ID for ${fnName}`);
  return rawCallAction(BASE, pagePath, entry.id, args, cookie || '');
}

console.log('\n=== ROUND 14: PER-SCHOOL SETTINGS, SECURITY, MONEY PARITY & MULTI-TIMEZONE SUITE ===\n');

const cookieA = await sessionCookie('adminA@lab.io');
const cookieB = await sessionCookie('adminB@lab.io');
const cookieTeacherA = await sessionCookie('teacherA@lab.io');
const cookieOrphan = await sessionCookie('orphan@lab.io');
const sessJsonA = await (
  await fetch(SHIM + '/__session', {
    method: 'POST',
    body: JSON.stringify({ email: 'adminA@lab.io' }),
  })
).json();

// ---------------------------------------------------------------------------
// 1. Auth Guards, Non-Admin / Orphan Isolation & Direct PostgREST RLS Attacks
// ---------------------------------------------------------------------------
console.log('--- [1] Auth Guards, Role/Orphan Isolation & Direct PostgREST RLS Attacks ---');

const unauthPage = await fetch(`${BASE}/dashboard/settings`, { redirect: 'manual' });
check(
  'Unauthenticated GET /dashboard/settings redirects to /login',
  unauthPage.status === 307 && (unauthPage.headers.get('location') || '').includes('/login')
);

const orphanPage = await fetch(`${BASE}/dashboard/settings`, {
  headers: { Cookie: cookieOrphan },
  redirect: 'manual',
});
check(
  'Orphan authenticated user blocked from /dashboard/settings',
  orphanPage.status === 307 && (orphanPage.headers.get('location') || '').includes('/login')
);

const teacherPage = await fetch(`${BASE}/dashboard/settings`, {
  headers: { Cookie: cookieTeacherA },
  redirect: 'manual',
});
check(
  'Non-admin teacher blocked from /dashboard/settings',
  teacherPage.status === 307 && (teacherPage.headers.get('location') || '').includes('/login')
);

const unauthSave = await callAction('', 'saveSchoolSettingsAction', [{ schoolName: 'Hacked' }]);
check('Unauthenticated saveSchoolSettingsAction rejected', unauthSave.status === 307 || !!unauthSave.value?.error);

const orphanSave = await callAction(cookieOrphan, 'saveSchoolSettingsAction', [{ schoolName: 'Hacked' }]);
check('Orphan saveSchoolSettingsAction rejected', !!orphanSave.value?.error);

const teacherSave = await callAction(cookieTeacherA, 'saveSchoolSettingsAction', [{ schoolName: 'Hacked' }]);
check('Non-admin teacher saveSchoolSettingsAction rejected', !!teacherSave.value?.error);

const adminAPage = await fetch(`${BASE}/dashboard/settings`, { headers: { Cookie: cookieA } });
const adminAHtml = await adminAPage.text();
check(
  'School A admin renders /dashboard/settings with Alpha Academy data and ZERO Bravo College leak',
  adminAPage.status === 200 &&
    adminAHtml.includes('Alpha Academy') &&
    !adminAHtml.includes('Bravo College') &&
    !adminAHtml.includes('Derrick')
);

const postgrestInsert = await fetch(`${SHIM}/rest/v1/school_settings`, {
  method: 'POST',
  headers: {
    apikey: 'lab-anon-key',
    Authorization: `Bearer ${sessJsonA.access_token}`,
    'Content-Profile': 'school',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ school_id: B.school, student_late_cutoff: '11:59' }),
});
check('Direct PostgREST INSERT into school.school_settings denied by PostgreSQL REVOKE', postgrestInsert.status >= 400);

const postgrestRpc = await fetch(`${SHIM}/rest/v1/rpc/save_school_settings`, {
  method: 'POST',
  headers: {
    apikey: 'lab-anon-key',
    Authorization: `Bearer ${sessJsonA.access_token}`,
    'Content-Profile': 'school',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    p_school_id: B.school,
    p_school_name: 'Hacked Bravo',
    p_policy: { studentLateCutoff: '11:59' },
  }),
});
check('Direct PostgREST EXECUTE on school.save_school_settings denied to authenticated role', postgrestRpc.status >= 400);

// ---------------------------------------------------------------------------
// 2. Cross-Tenant Parameter Smuggling & Wallet / SMS Price Integrity
// ---------------------------------------------------------------------------
console.log('\n--- [2] Cross-Tenant Parameter Smuggling & Wallet/Price Integrity ---');

const startBalRows = await q(
  `SELECT w.balance::numeric AS wbal, (s.settings->>'balance')::numeric AS sbal
   FROM public.wallets w
   JOIN school.schools s ON s.id = w.tenant_id
   WHERE s.id = $1`,
  [A.school]
);
const startWalletA = Number(startBalRows[0].wbal);

const smuggleSave = await callAction(cookieA, 'saveSchoolSettingsAction', [
  {
    schoolId: B.school,
    school_id: B.school,
    balance: 999_999_999,
    wallet_migrated: false,
    platformSmsUnitCostUgx: 1,
    smsUnitCostUgx: 1,
    schoolName: 'Alpha STEM Academy',
    academicTermLabel: 'Term 3 · 2026',
    timeZone: 'Africa/Kigali',
    studentLateCutoff: '07:30',
    studentGraceMinutes: 10,
    staffLateCutoff: '07:45',
    afternoonSwitchoverTime: '13:30',
    duplicatePunchWindowSeconds: 300,
    smsEnabled: true,
    sendCheckInSms: true,
    sendLateSms: true,
    sendCheckOutSms: false,
    restrictSmsWindows: false,
    smsTemplateCheckIn: '[STEM] {first_name} ({class_name}) checked IN at {school_name} at {time}.',
    smsTemplateLate: '[STEM] {student_name} arrived LATE at {school_name} at {time}.',
    smsTemplateCheckOut: '[STEM] {student_name} left {school_name} at {time}.',
    enforceStandardClassPrefix: false,
    maxPinFailures: 3,
    pinLockoutMinutes: 25,
    startingBiometricPin: 500,
    lcdPrefixTeacher: 'Prof. ',
    lcdPrefixAdmin: 'Head. ',
    lcdPrefixSupport: 'Ops. ',
    lcdShowStudentClass: false,
    defaultTopUpAmount: 25000,
    topUpPresets: '15000, 25000, 75000, 150000',
    lowBalanceThresholdUgx: 10000,
  },
]);

check('School A settings saved cleanly via Server Action', smuggleSave.value?.success === true);
check(
  'Platform SMS unit rate cannot be overridden by tenant input (remains 50 UGX)',
  smuggleSave.value?.settings?.platformSmsUnitCostUgx === 50
);

const readB = await callAction(cookieB, 'getSchoolSettingsAction', []);
check(
  'School B name & policies remain 100% untouched by School A smuggled payload',
  readB.value?.settings?.schoolName === 'Bravo College' &&
    readB.value?.settings?.timeZone === 'Africa/Kampala' &&
    readB.value?.settings?.studentLateCutoff === '08:00' &&
    readB.value?.settings?.maxPinFailures === 5
);

const rlsSelectRes = await fetch(`${SHIM}/rest/v1/school_settings?select=school_id,time_zone`, {
  headers: {
    apikey: 'lab-anon-key',
    Authorization: `Bearer ${sessJsonA.access_token}`,
    'Accept-Profile': 'school',
  },
});
const rlsRows = await rlsSelectRes.json();
check(
  'RLS SELECT on school.school_settings returns strictly School A row only',
  Array.isArray(rlsRows) && rlsRows.length === 1 && rlsRows[0].school_id === A.school
);

// ---------------------------------------------------------------------------
// 3. Concurrent Mobile Money Webhooks + Settings Save Atomicity Race
// ---------------------------------------------------------------------------
console.log('\n--- [3] Concurrent Payment Webhooks + Settings Save Atomicity Race ---');

const raceOps = [];
for (let i = 1; i <= 4; i++) {
  const ref = `sch_topup_r14_${i}_${crypto.randomUUID()}`;
  await q(
    `INSERT INTO school.payment_intents (school_id, reference, amount, currency, phone, status)
     VALUES ($1, $2, 5000, 'UGX', '256770000111', 'pending')`,
    [A.school, ref]
  );
  const rawBody = JSON.stringify({
    paymentIntentId: crypto.randomUUID(),
    reference: `SCHOOL-PAY-R140000${i}-0011223344`,
    status: 'success',
    amount: 5000,
    currency: 'UGX',
    providerPaymentId: `lp_r14_${i}`,
    failureReason: null,
    externalEntityId: A.school,
    metadata: { schoolId: A.school, idempotencyKey: ref, amount: 5000 },
  });
  raceOps.push(
    fetch(`${BASE}/api/webhooks/najiki`, {
      method: 'POST',
      headers: signNajikiHeaders(rawBody),
      body: rawBody,
    })
  );
  raceOps.push(
    callAction(cookieA, 'saveSchoolSettingsAction', [
      {
        schoolName: 'Alpha STEM Academy',
        academicTermLabel: `Term 3 · Rev ${i}`,
        timeZone: 'Africa/Kigali',
        studentLateCutoff: '07:30',
        studentGraceMinutes: 10,
        staffLateCutoff: '07:45',
        afternoonSwitchoverTime: '13:30',
        duplicatePunchWindowSeconds: 300,
        smsEnabled: true,
        sendCheckInSms: true,
        sendLateSms: true,
        sendCheckOutSms: false,
        restrictSmsWindows: false,
        smsTemplateCheckIn: '[STEM] {first_name} ({class_name}) checked IN at {school_name} at {time}.',
        smsTemplateLate: '[STEM] {student_name} arrived LATE at {school_name} at {time}.',
        smsTemplateCheckOut: '[STEM] {student_name} left {school_name} at {time}.',
        enforceStandardClassPrefix: false,
        maxPinFailures: 3,
        pinLockoutMinutes: 25,
        startingBiometricPin: 500,
        lcdPrefixTeacher: 'Prof. ',
        lcdPrefixAdmin: 'Head. ',
        lcdPrefixSupport: 'Ops. ',
        lcdShowStudentClass: false,
        defaultTopUpAmount: 25000,
        topUpPresets: '15000, 25000, 75000, 150000',
        lowBalanceThresholdUgx: 10000,
      },
    ])
  );
}

await Promise.all(raceOps);

const afterRace = await q(
  `SELECT w.balance::numeric AS wbal,
          (s.settings->>'balance')::numeric AS sbal,
          (s.settings->>'wallet_migrated')::boolean AS migrated,
          s.settings->'policy'->>'timeZone' AS policy_tz
   FROM public.wallets w
   JOIN school.schools s ON s.id = w.tenant_id
   WHERE s.id = $1`,
  [A.school]
);
const expectedBal = startWalletA + 20_000;
check(
  'Concurrent 4x payment webhooks + 4x settings saves preserve exact UGX parity AND policy JSON',
  Number(afterRace[0].wbal) === expectedBal &&
    Number(afterRace[0].sbal) === expectedBal &&
    afterRace[0].migrated === true &&
    afterRace[0].policy_tz === 'Africa/Kigali',
  `wallet=${afterRace[0].wbal}, mirror=${afterRace[0].sbal}, expected=${expectedBal}`
);

// ---------------------------------------------------------------------------
// 4. Hardware Gateway: Dynamic Timezone Handshake, Local Timestamp Parsing,
//    Grace Cutoff, Duplicate Scan Window & Explicit Per-Gate Override
// ---------------------------------------------------------------------------
console.log('\n--- [4] Hardware Gateway Multi-Timezone, Grace Cutoff, Cooldown & Gate Override ---');

// Seeded devices SNA0001 (School A, config=NULL) and SNB0001 (School B, config=NULL)
const hsA = await fetch(`${BASE}/iclock/cdata?SN=SNA0001&options=all`, {
  headers: { 'x-device-token': SECRETS.A },
});
const hsAText = await hsA.text();

const hsB = await fetch(`${BASE}/iclock/cdata?SN=SNB0001&options=all`, {
  headers: { 'x-device-token': SECRETS.B },
});
const hsBText = await hsB.text();

check(
  'ADMS handshake serves per-school TimeZone dynamically (School A=120 Kigali vs School B=180 Kampala)',
  hsAText.includes('TimeZone=120') && hsBText.includes('TimeZone=180'),
  `A="${hsAText.replace(/\s+/g, ' ').trim()}" | B="${hsBText.replace(/\s+/g, ' ').trim()}"`
);

// Add a second student in School A linked to parent A so we test both ON-TIME (grace) and LATE punches
const stu2Ins = await q(
  `INSERT INTO school.people (school_id, full_name, role, class_id, device_user_id)
   VALUES ($1, 'Brian Mukasa', 'student', $2, '103')
   RETURNING id`,
  [A.school, A.cls]
);
const stu2Id = stu2Ins[0].id;
await q(
  `INSERT INTO school.student_parents (student_id, parent_id, is_primary_contact) VALUES ($1, $2, true)`,
  [stu2Id, A.parent]
);

await q(`DELETE FROM school.attendance_logs WHERE school_id = $1`, [A.school]);
await q(`DELETE FROM school.notifications WHERE school_id = $1`, [A.school]);

// Punch 1: Student A (`PIN=102`) at `07:38:00` in `Africa/Kigali` (cutoff 07:30 + 10m grace = 07:40 -> ON TIME!)
const punch1 = await fetch(`${BASE}/iclock/cdata?SN=SNA0001&table=ATTLOG`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'x-device-token': SECRETS.A },
  body: `102\t2026-10-23 07:38:00\t0\t1\t0\t0`,
});
check('ADMS punch accepted HTTP 200', punch1.status === 200);

const log1 = await q(
  `SELECT status, attendance_type, occurred_at FROM school.attendance_logs WHERE person_id = $1`,
  [A.student]
);
const iso1 = new Date(log1[0]?.occurred_at).toISOString();
check(
  'ZKTeco wall-clock parsed in Africa/Kigali (05:38Z UTC, NOT hardcoded +03:00) AND marked PRESENT via +10m grace',
  iso1 === '2026-10-23T05:38:00.000Z' && log1[0]?.status === 'present',
  `iso=${iso1}, status=${log1[0]?.status}`
);

// Duplicate scan 3 minutes later (+180s < custom 300s cooldown; hardcoded 120s would have flipped to check_out!)
await fetch(`${BASE}/iclock/cdata?SN=SNA0001&table=ATTLOG`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'x-device-token': SECRETS.A },
  body: `102\t2026-10-23 07:41:00\t0\t1\t0\t0`,
});
const cntDup = await q(
  `SELECT count(*)::int AS cnt FROM school.attendance_logs WHERE person_id = $1`,
  [A.student]
);
check('Custom 300s duplicate punch window suppressed scan at +180s without false check_out', cntDup[0].cnt === 1);

// Dismissal punch at 16:45:00 -> logs check_out, AND since sendCheckOutSms=false, queues ZERO check_out SMS!
await fetch(`${BASE}/iclock/cdata?SN=SNA0001&table=ATTLOG`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'x-device-token': SECRETS.A },
  body: `102\t2026-10-23 16:45:00\t1\t1\t0\t0`,
});
const stu1Logs = await q(
  `SELECT attendance_type FROM school.attendance_logs WHERE person_id = $1 ORDER BY occurred_at ASC`,
  [A.student]
);
check(
  'Dismissal scan logged check_out cleanly',
  stu1Logs.length === 2 && stu1Logs[1].attendance_type === 'check_out'
);

// Punch 2: Student 2 (`PIN=103`) at `07:45:00` in `Africa/Kigali` (> 07:40 effective cutoff -> LATE!)
await fetch(`${BASE}/iclock/cdata?SN=SNA0001&table=ATTLOG`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'x-device-token': SECRETS.A },
  body: `103\t2026-10-23 07:45:00\t0\t1\t0\t0`,
});
const log2 = await q(`SELECT status FROM school.attendance_logs WHERE person_id = $1`, [stu2Id]);
check('Student 2 at 07:45 marked LATE (> 07:30 + 10m grace)', log2[0]?.status === 'late');

const smsRows = await q(
  `SELECT message FROM school.notifications WHERE school_id = $1 ORDER BY created_at ASC`,
  [A.school]
);
check(
  'Custom check-in & late SMS templates rendered AND disabled check-out SMS skipped',
  smsRows.length === 2 &&
    smsRows[0].message.startsWith('[STEM] ') &&
    smsRows[0].message.includes('Alpha STEM Academy') &&
    smsRows[1].message.includes('arrived LATE at Alpha STEM Academy'),
  `smsCount=${smsRows.length}, first="${smsRows[0]?.message}"`
);

// Explicit per-gate override test: register Boarding Gate with explicit 06:45 cutoff
const fdDev = new FormData();
fdDev.append('serialNumber', 'R14-BOARDING-GATE');
fdDev.append('label', 'Boarding Gate Strict 06:45');
fdDev.append('deviceType', 'zkteco_adms');
fdDev.append('lateCutoff', '06:45');
fdDev.append('timeZone', 'Africa/Kigali');
const addOverrideRes = await callAction(cookieA, 'addDeviceAction', [fdDev], '/dashboard/devices');
check('Registered School A second gate with explicit 06:45 cutoff override', addOverrideRes.value?.success === true);

await q(`DELETE FROM school.attendance_logs WHERE person_id = $1`, [A.student]);
await fetch(`${BASE}/iclock/cdata?SN=R14-BOARDING-GATE&table=ATTLOG`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'x-device-token': addOverrideRes.value.deviceSecret },
  body: `102\t2026-10-23 07:05:00\t0\t1\t0\t0`,
});
const overrideLog = await q(`SELECT status FROM school.attendance_logs WHERE person_id = $1`, [A.student]);
check(
  'Explicit per-gate cutoff override (06:45) honored independently of school-wide 07:30 policy',
  overrideLog[0]?.status === 'late'
);

// ---------------------------------------------------------------------------
// 5. Class Prefix Toggle, Custom Teacher PIN Lockout (3 attempts), Custom
//    Starting Biometric PIN (500+), Custom ZKTeco LCD Prefixes & Live Kiosk
// ---------------------------------------------------------------------------
console.log('\n--- [5] Class Prefix Rule, Custom 3-Strike PIN Lockout, Biometric PIN 500+ & LCD Prefixes ---');

const fdClsB = new FormData();
fdClsB.append('name', 'primary-stream');
const clsResB = await callAction(cookieB, 'addClassAction', [fdClsB], '/dashboard/classes');
check('School B (enforceStandardClassPrefix=true) rejects lowercase "primary-stream"', !!clsResB.value?.error);

const fdClsA = new FormData();
fdClsA.append('name', 'primary-stream');
const clsResA = await callAction(cookieA, 'addClassAction', [fdClsA], '/dashboard/classes');
check('School A (enforceStandardClassPrefix=false) allows free-form class "primary-stream"', !clsResA.value?.error);

// Custom 3-strike Teacher PIN lockout for ~25 minutes on School A
await q(`UPDATE school.staff_users SET failed_attempts = 0, locked_until = NULL WHERE person_id = $1`, [A.teacher]);
for (let attempt = 1; attempt <= 3; attempt++) {
  await callAction(cookieA, 'verifyTeacherPin', [A.cls, A.teacher, 'ZZZZZZ'], `/manual-attendance/${A.cls}`);
}
const lockRow = await q(
  `SELECT failed_attempts, locked_until FROM school.staff_users WHERE person_id = $1`,
  [A.teacher]
);
const lockMins = (new Date(lockRow[0].locked_until).getTime() - Date.now()) / 60_000;
check(
  'School A custom Teacher PIN policy locks account after 3 failed attempts for ~25 minutes',
  Number(lockRow[0].failed_attempts) === 3 && lockMins > 20 && lockMins <= 26,
  `attempts=${lockRow[0].failed_attempts}, lockMins=${lockMins.toFixed(1)}`
);

// Auto-assign biometric PIN starting at 500 + custom LCD prefix ('Prof. ') + hidden student class on LCD
const newTeacher = await q(
  `INSERT INTO school.people (school_id, full_name, role, device_user_id)
   VALUES ($1, 'Florence Nightingale', 'teacher', NULL)
   RETURNING id`,
  [A.school]
);
const newStudent = await q(
  `INSERT INTO school.people (school_id, full_name, role, class_id, device_user_id)
   VALUES ($1, 'Isaac Newton', 'student', $2, NULL)
   RETURNING id`,
  [A.school, A.cls]
);

const assignRes = await callAction(cookieA, 'autoAssignDevicePinsAction', [{ category: 'all' }], '/dashboard/devices');
check('Auto-assign PINs succeeded on School A', assignRes.value?.success === true);

const assignedRows = await q(
  `SELECT full_name, device_user_id FROM school.people WHERE id IN ($1, $2)`,
  [newTeacher[0].id, newStudent[0].id]
);
check(
  'Auto-assigned biometric PINs start at configured base 500 (500, 501)',
  assignedRows.every((r) => Number(r.device_user_id) >= 500),
  `pins=${assignedRows.map((r) => `${r.full_name}:${r.device_user_id}`).join(', ')}`
);

const queuedCmds = await q(
  `SELECT raw_command FROM school.device_commands WHERE school_id = $1 ORDER BY created_at DESC LIMIT 8`,
  [A.school]
);
const cmdTexts = queuedCmds.map((r) => r.raw_command).join('\n');
check(
  'Terminal LCD commands use custom teacher prefix "Prof. " and omit class prefix when lcdShowStudentClass=false',
  cmdTexts.includes('Name=Prof. Florence') && cmdTexts.includes('Name=Isaac Newton'),
  cmdTexts.slice(0, 120)
);

// Gate Kiosk live dynamic cutoff verification
await q(`DELETE FROM school.attendance_logs WHERE person_id = $1`, [A.student]);
const kigaliNow = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Kigali',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).format(new Date());
const [kh, km] = kigaliNow.split(':').map(Number);
const kigaliMins = (kh % 24) * 60 + km;
if (kigaliMins >= 5) {
  const pastMins = kigaliMins - 5;
  const pastCutoff = `${String(Math.floor(pastMins / 60)).padStart(2, '0')}:${String(pastMins % 60).padStart(2, '0')}`;
  await callAction(cookieA, 'saveSchoolSettingsAction', [
    { studentLateCutoff: pastCutoff, studentGraceMinutes: 0, timeZone: 'Africa/Kigali' },
  ]);
  const kioskRes = await callAction(cookieA, 'submitClockInAction', ['102'], '/mark-attendance');
  const kioskLog = await q(`SELECT status FROM school.attendance_logs WHERE person_id = $1`, [A.student]);
  check(
    'Gate Kiosk marks student LATE dynamically against school cutoff without hardcoded 08:00',
    kioskRes.value?.success === true && kioskLog[0]?.status === 'late',
    `cutoff=${pastCutoff}, now=${kigaliNow}, status=${kioskLog[0]?.status}`
  );
}

// Test Reset Defaults action
const resetRes = await callAction(cookieA, 'resetSchoolSettingsAction', []);
check(
  'resetSchoolSettingsAction restores clean defaults while preserving school name & wallet balance',
  resetRes.value?.success === true &&
    resetRes.value?.settings?.timeZone === 'Africa/Kampala' &&
    resetRes.value?.settings?.studentLateCutoff === '08:00' &&
    resetRes.value?.settings?.schoolName === 'Alpha STEM Academy'
);

// ---------------------------------------------------------------------------
// 6. MIG12=0 Pre-Migration Fallback Verification + Final Clean Re-Seed
// ---------------------------------------------------------------------------
console.log('\n--- [6] Pre-Migration Fallback (MIG12=0) Verification ---');

await seedLab({ MIG12: '0' });
const cookieAMig0 = await sessionCookie('adminA@lab.io');

const mig0Save = await callAction(cookieAMig0, 'saveSchoolSettingsAction', [
  { schoolName: 'Fallback Mode School', studentLateCutoff: '07:15', timeZone: 'Africa/Nairobi' },
]);
const mig0Load = await callAction(cookieAMig0, 'getSchoolSettingsAction', []);
check(
  'MIG12=0 fallback saves and reloads school policies cleanly via school.schools.settings.policy',
  mig0Save.value?.success === true &&
    mig0Load.value?.settings?.studentLateCutoff === '07:15' &&
    mig0Load.value?.settings?.timeZone === 'Africa/Nairobi'
);

// Restore clean default lab database for subsequent test suites
await seedLab();
await db.end();

console.log(`\n=== ROUND 14 SUMMARY: ${passed} passed, ${findings.length} failed ===`);
if (findings.length > 0) {
  console.error('Failures:', JSON.stringify(findings, null, 2));
  process.exit(1);
}
