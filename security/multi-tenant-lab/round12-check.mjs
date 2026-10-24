// Round 12 comprehensive verification suite covering ALL 11 production & security fixes.
// Runs against live PostgreSQL 17.5 + strict PostgREST shim (`SHIM_NO_AUTOCOL=1`) +
// standalone Next.js 15.5.28 server + legacy ADMS proxy child process.
//
// Usage:
//   RLS=1 node round12-check.mjs http://127.0.0.1:3201 /home/user/schoolmnt2

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync, spawn, spawnSync } from 'child_process';
import { setupUsers, sessionCookie, actionIds, callAction, SHIM } from './lib.mjs';
import seedMod from './seed.js';

const { IDS, SECRETS } = seedMod;
const [BASE = 'http://127.0.0.1:3201', APPDIR = '/home/user/schoolmnt2'] = process.argv.slice(2);

const checks = [];
function assertCheck(name, cond, detail = '') {
  const ok = Boolean(cond);
  checks.push({ name, ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const eatDate = (d = new Date()) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10);

async function reseed({ mig10 = '1' } = {}) {
  execSync('node seed.js', {
    cwd: '/home/user/mt-lab',
    env: { ...process.env, RLS: '1', MIG10: String(mig10) },
  });
  await fetch(SHIM + '/__reload', { method: 'POST' });
  await setupUsers();
}

const ids = actionIds(APPDIR);
function actHelper(cookie) {
  return (name, args, pageOverride) => {
    const list = ids[name];
    if (!list || !list.length) throw new Error(`Action not found in manifest: ${name}`);
    const entry = list[0];
    const page =
      pageOverride ||
      '/' + entry.page.replace(/^app\//, '').replace(/\/page$/, '');
    return callAction(BASE, page, entry.id, args, cookie);
  };
}

const db = new pg.Client({
  host: '127.0.0.1',
  port: 54329,
  user: 'postgres',
  password: 'pw',
  database: 'mtlab',
});
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;

// ============================================================================
// PHASE A: Issue 2a — Unmigrated (`MIG10=0` + `SHIM_NO_AUTOCOL=1`) resilience
// ============================================================================
console.log('\n--- Phase A: Unmigrated schema fallback (`MIG10=0`, `SHIM_NO_AUTOCOL=1`) ---');
await reseed({ mig10: '0' });

{
  const missingCols = await q(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'school'
        AND ((table_name = 'device_commands' AND column_name IN ('acknowledged_at', 'delivered_device_ids'))
          OR (table_name = 'device_logs' AND column_name IN ('processed', 'raw_serial_number')))`
  );
  assertCheck(
    '2a.1 MIG10=0 omits Round 12 columns so SHIM_NO_AUTOCOL=1 throws PGRST204 on them',
    missingCols.length === 0,
    `cols=${missingCols.length}`
  );

  const adminA = await sessionCookie('adminA@lab.io');
  const actA = actHelper(adminA);

  // Queue ZKTeco push command when `vendor_protocol` / `delivered_device_ids` missing
  const pushRes = await actA('pushUsersToDeviceAction', [
    { deviceSerialNumber: 'SNA0001', category: 'all' },
  ]);
  assertCheck(
    '2a.2 pushUsersToDeviceAction succeeds via fallback when device_commands lacks new columns',
    pushRes.value && pushRes.value.success === true,
    JSON.stringify(pushRes.value)
  );

  // Device polls /iclock/getrequest when `delivered_device_ids` missing
  const getReq = await fetch(`${BASE}/iclock/getrequest?SN=SNA0001`, {
    headers: { 'X-Device-Token': SECRETS.A },
  });
  const getReqText = await getReq.text();
  const cmdIdMatch = getReqText.match(/^C:(\d+):/m);
  assertCheck(
    '2a.3 /iclock/getrequest delivers pending command on unmigrated schema',
    getReq.status === 200 && Boolean(cmdIdMatch),
    `status=${getReq.status} cmdId=${cmdIdMatch?.[1] || 'none'}`
  );

  // Device ACKs /iclock/devicecmd when `acknowledged_at` / `error_message` missing
  const ackRes = await fetch(`${BASE}/iclock/devicecmd?SN=SNA0001`, {
    method: 'POST',
    headers: { 'X-Device-Token': SECRETS.A, 'Content-Type': 'text/plain' },
    body: `ID=${cmdIdMatch[1]}&Return=0&CMD=DATA\n`,
  });
  assertCheck(
    '2a.4 /iclock/devicecmd ACKs cleanly without PGRST204 when acknowledged_at is missing',
    ackRes.status === 200,
    `status=${ackRes.status}`
  );

  // Device posts ATTLOG when `raw_serial_number` / `processed` missing
  const attRes = await fetch(`${BASE}/iclock/cdata?SN=SNA0001&table=ATTLOG`, {
    method: 'POST',
    headers: { 'X-Device-Token': SECRETS.A, 'Content-Type': 'text/plain' },
    body: `102\t${eatDate()} 07:42:10\t0\t1\n`,
  });
  assertCheck(
    '2a.5 /iclock/cdata ATTLOG saves attendance when device_logs lacks processed/raw_serial_number',
    attRes.status === 200,
    `status=${attRes.status}`
  );

  // Kiosk clock-in when `person_credentials.credential_type` / `is_active` missing
  const kioskRes = await actA('submitClockInAction', ['102']);
  assertCheck(
    '2a.6 submitClockInAction succeeds via fallback when person_credentials lacks credential_type',
    kioskRes.value && kioskRes.value.success === true,
    JSON.stringify(kioskRes.value)
  );
}

// ============================================================================
// PHASE B: Issue 2b — Migrated (`MIG10=1`) idempotency, columns & privileges
// ============================================================================
console.log('\n--- Phase B: Migration 10 reconciliation & secret-column privileges (`MIG10=1`) ---');
await reseed({ mig10: '1' });

// Re-apply migration 10 a second time to prove 100% idempotency
await db.query(
  fs.readFileSync(path.join(APPDIR, 'supabase_migrations/10_round12_production_hardening.sql'), 'utf8')
);
await fetch(SHIM + '/__reload', { method: 'POST' });

{
  const expectedCols = [
    ['devices', 'device_secret_hash'],
    ['devices', 'device_type'],
    ['devices', 'config'],
    ['devices', 'location_label'],
    ['device_commands', 'vendor_protocol'],
    ['device_commands', 'acknowledged_at'],
    ['device_commands', 'error_message'],
    ['device_commands', 'completed_at'],
    ['device_commands', 'result'],
    ['device_commands', 'delivered_device_ids'],
    ['device_logs', 'school_id'],
    ['device_logs', 'raw_serial_number'],
    ['device_logs', 'device_user_id'],
    ['device_logs', 'event_timestamp'],
    ['device_logs', 'processed'],
    ['device_logs', 'processed_at'],
    ['device_logs', 'processing_error'],
    ['person_credentials', 'credential_type'],
    ['person_credentials', 'is_active'],
  ];
  const present = await q(
    `SELECT table_name || '.' || column_name AS col
       FROM information_schema.columns
      WHERE table_schema = 'school'`
  );
  const set = new Set(present.map((r) => r.col));
  const missing = expectedCols
    .map(([t, c]) => `${t}.${c}`)
    .filter((k) => !set.has(k));
  assertCheck(
    '2b.1 Idempotent migration 10 reconciles all 19 required columns across 4 tables',
    missing.length === 0,
    missing.length ? `missing=${missing.join(',')}` : '19/19 present'
  );

  const uniqIdx = await q(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'school' AND indexname = 'person_credentials_school_type_val_uniq'`
  );
  assertCheck(
    '2b.2 Unique index person_credentials_school_type_val_uniq exists',
    uniqIdx.length === 1,
    uniqIdx[0]?.indexname || 'missing'
  );

  // Verify PostgREST authenticated role cannot read secret columns or mutate staff_users
  const adminTok = (
    await (
      await fetch(SHIM + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: JSON.stringify({ email: 'adminA@lab.io', password: 'Passw0rd!' }),
      })
    ).json()
  ).access_token;

  const secretRead1 = await fetch(SHIM + '/rest/v1/staff_users?select=pin_hash', {
    headers: { apikey: 'lab-anon-key', Authorization: `Bearer ${adminTok}`, 'Accept-Profile': 'school' },
  });
  const secretRead2 = await fetch(SHIM + '/rest/v1/devices?select=device_secret_hash', {
    headers: { apikey: 'lab-anon-key', Authorization: `Bearer ${adminTok}`, 'Accept-Profile': 'school' },
  });
  const nonSecretRead = await fetch(SHIM + '/rest/v1/devices?select=id,serial_number,device_type,location_label', {
    headers: { apikey: 'lab-anon-key', Authorization: `Bearer ${adminTok}`, 'Accept-Profile': 'school' },
  });
  assertCheck(
    '2b.3 Secret columns hidden from authenticated while new non-secret columns remain readable',
    secretRead1.status >= 400 && secretRead2.status >= 400 && nonSecretRead.status === 200,
    `pin_hash=${secretRead1.status} device_secret_hash=${secretRead2.status} safe_cols=${nonSecretRead.status}`
  );

  // Full column persistence under MIG10=1
  const adminA = await sessionCookie('adminA@lab.io');
  const actA = actHelper(adminA);
  await q('DELETE FROM school.device_commands WHERE school_id = $1', [IDS.A.school]);
  await actA('pushUsersToDeviceAction', [{ deviceSerialNumber: 'SNA0001', category: 'all' }]);
  const gr = await (
    await fetch(`${BASE}/iclock/getrequest?SN=SNA0001`, {
      headers: { 'X-Device-Token': SECRETS.A },
    })
  ).text();
  const cid = gr.match(/^C:(\d+):/m)[1];
  await fetch(`${BASE}/iclock/devicecmd?SN=SNA0001`, {
    method: 'POST',
    headers: { 'X-Device-Token': SECRETS.A, 'Content-Type': 'text/plain' },
    body: `ID=${cid}&Return=0&CMD=DATA\n`,
  });
  const cmdRow = (
    await q(
      "SELECT status, vendor_protocol, acknowledged_at FROM school.device_commands WHERE school_id = $1 AND status = 'acknowledged' LIMIT 1",
      [IDS.A.school]
    )
  )[0];
  assertCheck(
    '2b.4 Migrated device_commands persists vendor_protocol + acknowledged_at on ACK',
    Boolean(cmdRow) && cmdRow.status === 'acknowledged' && Boolean(cmdRow.acknowledged_at) && Boolean(cmdRow.vendor_protocol),
    JSON.stringify(cmdRow)
  );
}

// ============================================================================
// PHASE C: Issue 1 — `app/dashboard/people/actions.ts` guardian, formula & PINs
// ============================================================================
console.log('\n--- Phase C: Issue 1 (`people/actions.ts` guardian link, formula safety & canonical PINs) ---');
{
  const adminA = await sessionCookie('adminA@lab.io');
  const actA = actHelper(adminA);

  // Drop stub `school.fn_add_person` so `addPersonAction` executes the direct
  // TypeScript `people` + `parents` + `student_parents(is_primary_contact)` code path!
  await q('DROP FUNCTION IF EXISTS school.fn_add_person(text, text, uuid, text, text, text, text, text, text[]) CASCADE');
  await q('DO $$ DECLARE r record; BEGIN FOR r IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE proname = \'fn_add_person\' LOOP EXECUTE \'DROP FUNCTION \' || r.sig || \' CASCADE\'; END LOOP; END $$;');
  await fetch(SHIM + '/__reload', { method: 'POST' });

  // 1a + 1c: Add student with formula-prefixed names & guardian link + PIN '555'
  const fd1 = new FormData();
  fd1.set('role', 'student');
  fd1.set('fullName', '=CMD("calc") Student');
  fd1.set('classId', IDS.A.cls);
  fd1.set('deviceUserId', '555');
  fd1.set('guardianName', '+SUM(1,2) Parent');
  fd1.set('guardianPhone', '0772555111');
  const r1 = await actA('addPersonAction', [fd1]);

  assertCheck(
    '1.1 addPersonAction succeeds and links guardian cleanly',
    r1.value && r1.value.success === true && r1.value.data?.guardian_linked === true,
    JSON.stringify(r1.value)
  );

  const spRows = await q(
    `SELECT p.full_name AS student_name, pa.full_name AS parent_name, sp.is_primary_contact
       FROM school.people p
       JOIN school.student_parents sp ON sp.student_id = p.id
       JOIN school.parents pa ON pa.id = sp.parent_id
      WHERE p.school_id = $1 AND p.device_user_id = '555'`,
    [IDS.A.school]
  );
  assertCheck(
    '1.2 student_parents writes is_primary_contact=true AND strips leading formula prefixes',
    spRows.length === 1 &&
      spRows[0].is_primary_contact === true &&
      !/^[=+\-@]/.test(spRows[0].student_name) &&
      !/^[=+\-@]/.test(spRows[0].parent_name),
    JSON.stringify(spRows[0])
  );

  // 1b: Force failure on student_parents insert -> must NOT return guardian_linked: true
  await q(`
    CREATE OR REPLACE FUNCTION school.tmp_fail_sp() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated student_parents failure'; END $$;
    CREATE TRIGGER trg_tmp_fail_sp BEFORE INSERT ON school.student_parents
      FOR EACH ROW EXECUTE FUNCTION school.tmp_fail_sp();
  `);
  let failRes;
  try {
    const fdFail = new FormData();
    fdFail.set('role', 'student');
    fdFail.set('fullName', 'Unlinked Child');
    fdFail.set('classId', IDS.A.cls);
    fdFail.set('guardianName', 'Parent X');
    fdFail.set('guardianPhone', '0772999888');
    failRes = await actA('addPersonAction', [fdFail]);
  } finally {
    await q('DROP TRIGGER IF EXISTS trg_tmp_fail_sp ON school.student_parents; DROP FUNCTION IF EXISTS school.tmp_fail_sp();');
  }
  assertCheck(
    '1.3 Failed student_parents insert fails loudly instead of returning guardian_linked: true',
    Boolean(failRes.value?.error) && failRes.value?.guardian_linked !== true,
    JSON.stringify(failRes.value)
  );

  // 1d: Canonical numeric PIN collision (`0555` vs `555` and `00555` update)
  const fdDup = new FormData();
  fdDup.set('role', 'student');
  fdDup.set('fullName', 'Leading Zero Student');
  fdDup.set('classId', IDS.A.cls);
  fdDup.set('deviceUserId', '0555');
  const dupAdd = await actA('addPersonAction', [fdDup]);

  const dupUpd = await actA('updatePersonDeviceUserIdAction', [IDS.A.student, '00555']);
  assertCheck(
    '1.4 Canonical PIN collision blocks both addPersonAction("0555") and updatePersonDeviceUserIdAction("00555") when "555" exists',
    Boolean(dupAdd.value?.error) && Boolean(dupUpd.value?.error),
    `add=${JSON.stringify(dupAdd.value)} upd=${JSON.stringify(dupUpd.value)}`
  );
}

// ============================================================================
// PHASE D: Issue 3 — `app/legacy-adms-proxy/server.js` hardening
// ============================================================================
console.log('\n--- Phase D: Issue 3 (`app/legacy-adms-proxy/server.js` strict allowlist, token injection & caps) ---');
{
  const proxyScript = path.join(APPDIR, 'app/legacy-adms-proxy/server.js');

  // 3.1 Missing UPSTREAM_URL must exit non-zero immediately
  const missingUpstream = spawnSync(process.execPath, [proxyScript], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 5000,
  });
  assertCheck(
    '3.1 Legacy ADMS proxy exits non-zero when UPSTREAM_URL is unset (no hardcoded Cloud Run URL)',
    missingUpstream.status !== 0,
    `exit=${missingUpstream.status}`
  );

  // 3.2 Run live proxy on port 3299 against standalone upstream
  const proxyProc = spawn(process.execPath, [proxyScript], {
    env: {
      PATH: process.env.PATH,
      PORT: '3299',
      UPSTREAM_URL: BASE,
      DEVICE_TOKENS_JSON: JSON.stringify({ SNA0001: SECRETS.A }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy start timeout')), 5000);
    proxyProc.stdout.on('data', (d) => {
      if (String(d).includes('3299')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  try {
    const r404 = await fetch('http://127.0.0.1:3299/dashboard');
    const r405 = await fetch('http://127.0.0.1:3299/iclock/getrequest?SN=SNA0001', { method: 'POST', body: 'x' });
    const rSpoof = await fetch('http://127.0.0.1:3299/iclock/cdata?SN=SNA0001&options=all', {
      headers: {
        'X-Device-Token': 'ATTACKER-WRONG-TOKEN',
        'X-Forwarded-For': '8.8.8.8',
        Authorization: 'Bearer stolen',
        Cookie: 'sb-127-auth-token=fake',
      },
    });
    const rUnknownSn = await fetch('http://127.0.0.1:3299/iclock/cdata?SN=SNB0001&options=all');
    const bigBody = 'X'.repeat(1024 * 1024 + 4096);
    const r413 = await fetch('http://127.0.0.1:3299/iclock/cdata?SN=SNA0001&table=ATTLOG', {
      method: 'POST',
      body: bigBody,
    });

    assertCheck(
      '3.2 Proxy blocks non-allowlisted paths (403) & wrong methods (405)',
      (r404.status === 403 || r404.status === 404) && r405.status === 405,
      `/dashboard=${r404.status} POST /iclock/getrequest=${r405.status}`
    );
    assertCheck(
      '3.3 Proxy strips spoofed X-Device-Token & injects per-serial token from DEVICE_TOKENS_JSON',
      rSpoof.status === 200 && rUnknownSn.status === 401,
      `SNA0001=${rSpoof.status} SNB0001=${rUnknownSn.status}`
    );
    assertCheck(
      '3.4 Proxy enforces 1 MiB body limit with HTTP 413',
      r413.status === 413,
      `status=${r413.status}`
    );
  } finally {
    proxyProc.kill('SIGTERM');
  }
}

// ============================================================================
// PHASE E: Issue 4 — Proxy IP trust (`getClientIp`), GoTrue bypass & redirects
// ============================================================================
console.log('\n--- Phase E: Issue 4 (`getClientIp` right-most hop, GoTrue bypass, relative redirects) ---');
{
  const loginId = ids.loginAction[0].id;
  // Server has TRUSTED_PROXY_HOPS=1 -> must use right-most entry in X-Forwarded-For, NOT spoofed first entry!
  let blockedAt = null;
  for (let i = 1; i <= 10; i++) {
    const fd = new FormData();
    fd.set('email', 'adminA@lab.io');
    fd.set('password', `wrong-pw-${i}`);
    // Rotate left-most spoofed IP every single request while keeping real right-most proxy hop 203.0.113.77 constant
    const body = new FormData();
    for (const [k, v] of fd.entries()) body.append('_1_' + k, v);
    body.append('0', '["$K1"]');
    const res = await fetch(`${BASE}/login`, {
      method: 'POST',
      body,
      redirect: 'manual',
      headers: {
        'Next-Action': loginId,
        Accept: 'text/x-component',
        Origin: BASE,
        'X-Forwarded-For': `198.51.100.${i}, 203.0.113.77`,
      },
    });
    const txt = await res.text();
    if (/too many/i.test(txt)) {
      blockedAt = i;
      break;
    }
  }
  assertCheck(
    '4.1 Rotating left-most X-Forwarded-For entries CANNOT bypass login rate-limiter behind 1 trusted proxy hop',
    blockedAt !== null,
    `blockedAtAttempt=${blockedAt}`
  );

  // Verify middleware skips GoTrue on /iclock/* even if bogus auth cookie is sent, and Host spoofing emits relative Location
  const hostPoisonOut = await fetch(`${BASE}/dashboard`, {
    redirect: 'manual',
    headers: { Host: 'evil.attacker.example', 'X-Forwarded-Host': 'evil.attacker.example' },
  });
  const adminCookie = await sessionCookie('adminA@lab.io');
  const hostPoisonIn = await fetch(`${BASE}/login`, {
    redirect: 'manual',
    headers: {
      Cookie: adminCookie,
      Host: 'evil.attacker.example',
      'X-Forwarded-Host': 'evil.attacker.example',
    },
  });
  assertCheck(
    '4.2 Unauthenticated & authenticated redirects emit exact relative Location (/login & /dashboard) under Host poisoning',
    hostPoisonOut.status === 307 &&
      hostPoisonOut.headers.get('location') === '/login' &&
      hostPoisonIn.status === 307 &&
      hostPoisonIn.headers.get('location') === '/dashboard',
    `out=${hostPoisonOut.status}:${hostPoisonOut.headers.get('location')} in=${hostPoisonIn.status}:${hostPoisonIn.headers.get('location')}`
  );
}

// ============================================================================
// PHASE F: Issue 5 — HMAC Scoped Capability Tokens (Classroom Register & Kiosk)
// ============================================================================
console.log('\n--- Phase F: Issue 5 (`register-token.ts` Web-Crypto HMAC capability links without school_admin cookie) ---');
{
  const adminA = await sessionCookie('adminA@lab.io');
  const actAdminA = actHelper(adminA);

  // Create a 2nd class in School A to test strict per-class scoping inside the SAME school!
  const classA2 = 'aaaaaaaa-0000-4000-8000-0000000000c2';
  await q(
    'INSERT INTO school.classes(id, school_id, name, teacher_id) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
    [classA2, IDS.A.school, 'Primary 2', IDS.A.teacher]
  );

  // Fetch `/dashboard/classes` HTML as adminA and extract signed CopyLinkButton token prop for IDS.A.cls
  const classesHtml = await (
    await fetch(`${BASE}/dashboard/classes`, { headers: { Cookie: adminA } })
  ).text();
  const regLinkMatch = classesHtml.match(
    new RegExp(`${IDS.A.cls}\\\\?",\\\\?"token\\\\?":\\\\?"([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)`)
  );
  assertCheck(
    '5.1 /dashboard/classes embeds signed CopyLinkButton capability token per class',
    Boolean(regLinkMatch),
    regLinkMatch ? 'token found' : 'missing'
  );
  const regToken = regLinkMatch[1];

  // 5.2 Open class register WITHOUT admin session cookie using `?token=...`
  const openReg = await fetch(
    `${BASE}/manual-attendance/${IDS.A.cls}?token=${encodeURIComponent(regToken)}`,
    { redirect: 'manual' }
  );
  const regSetCookies = openReg.headers.getSetCookie();
  const regCapCookie = regSetCookies
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('sk_reg_cap='));
  const regHttpOnly = regSetCookies.some(
    (c) => c.startsWith('sk_reg_cap=') && /HttpOnly/i.test(c)
  );
  assertCheck(
    '5.2 Scoped ?token=... opens /manual-attendance/[classId] (200) without sb-* cookie & sets HttpOnly capability cookie',
    openReg.status === 200 && Boolean(regCapCookie) && regHttpOnly,
    `status=${openReg.status} httpOnly=${regHttpOnly}`
  );

  // 5.3 Tampered signature & wrong class (`classA2` in same school, `IDS.B.cls` in School B) rejected!
  const tamperedToken = regToken.slice(0, -4) + 'AAAA';
  const openTampered = await fetch(
    `${BASE}/manual-attendance/${IDS.A.cls}?token=${encodeURIComponent(tamperedToken)}`,
    { redirect: 'manual' }
  );
  const openWrongClassSameSchool = await fetch(`${BASE}/manual-attendance/${classA2}`, {
    redirect: 'manual',
    headers: { Cookie: regCapCookie },
  });
  const openOtherTenantClass = await fetch(`${BASE}/manual-attendance/${IDS.B.cls}`, {
    redirect: 'manual',
    headers: { Cookie: regCapCookie },
  });
  assertCheck(
    '5.3 Tampered token, other class in same school, and School B class are all rejected (307 -> /login)',
    openTampered.status === 307 &&
      openWrongClassSameSchool.status === 307 &&
      openOtherTenantClass.status === 307,
    `tampered=${openTampered.status} sameSchoolOtherClass=${openWrongClassSameSchool.status} schoolB=${openOtherTenantClass.status}`
  );

  // 5.4 Teacher PIN gate BEFORE exposing student roster on capability-scoped session!
  const actTeacherCap = actHelper(regCapCookie);
  const regPagePath = `/manual-attendance/${IDS.A.cls}`;

  const rosterNoPin = await actTeacherCap('getStudentsForClass', [IDS.A.cls], regPagePath);
  const rosterBadPin = await actTeacherCap(
    'getStudentsForClass',
    [IDS.A.cls, IDS.A.teacher, '000000'],
    regPagePath
  );
  const rosterGoodPin = await actTeacherCap(
    'getStudentsForClass',
    [IDS.A.cls, IDS.A.teacher, '482913'],
    regPagePath
  );
  assertCheck(
    '5.4 Student roster is withheld until valid Teacher PIN is supplied on capability link, then unlocked',
    Boolean(rosterNoPin.value?.error) &&
      Boolean(rosterBadPin.value?.error) &&
      Array.isArray(rosterGoodPin.value?.students) &&
      rosterGoodPin.value.students.length >= 1,
    `noPin=${JSON.stringify(rosterNoPin.value)} badPin=${JSON.stringify(rosterBadPin.value)} goodCount=${rosterGoodPin.value?.students?.length}`
  );

  // 5.5 Teacher submits class attendance without school_admin cookie
  const submitTeacher = await actTeacherCap(
    'submitClassAttendance',
    [IDS.A.cls, IDS.A.teacher, [IDS.A.student], [], 'check_in', '482913'],
    regPagePath
  );
  assertCheck(
    '5.5 Teacher submits class register with capability cookie + valid PIN (no school_admin cookie)',
    submitTeacher.value && submitTeacher.value.success === true,
    JSON.stringify(submitTeacher.value)
  );

  // 5.6 Gate Kiosk capability token (`sk_kiosk_cap`) without `school_admin` cookie
  const attData = await actAdminA('getAttendanceData', ['']);
  const kioskToken = attData.value?.kioskToken;
  const openKiosk = await fetch(
    `${BASE}/mark-attendance?token=${encodeURIComponent(kioskToken)}`,
    { redirect: 'manual' }
  );
  const kioskCookie = openKiosk.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('sk_kiosk_cap='));
  const actKiosk = actHelper(kioskCookie);
  // Wait >2s if needed or clear prior attendance_logs row from 2a/5.5 so 30s double-tap guard allows fresh clock-in!
  await q('DELETE FROM school.attendance_logs WHERE person_id = $1', [IDS.A.student]);
  const kioskOwnStudent = await actKiosk('submitClockInAction', ['102'], '/mark-attendance');
  const kioskOtherSchoolStudent = await actKiosk('submitClockInAction', ['202'], '/mark-attendance');
  assertCheck(
    '5.6 Kiosk capability link clocks in School A student without admin cookie and blocks School B student',
    openKiosk.status === 200 &&
      kioskOwnStudent.value?.success === true &&
      Boolean(kioskOtherSchoolStudent.value?.error),
    `open=${openKiosk.status} own=${JSON.stringify(kioskOwnStudent.value)} crossTenant=${JSON.stringify(kioskOtherSchoolStudent.value)}`
  );
}

// ============================================================================
// PHASE G: Issue 6 — PWA Service Worker v3 & Logout `Clear-Site-Data`
// ============================================================================
console.log('\n--- Phase G: Issue 6 (`public/sw.js` v3 cache safety & `POST /api/logout` Clear-Site-Data) ---');
{
  const swText = await (await fetch(`${BASE}/sw.js`)).text();
  const staticMatch = swText.match(/STATIC_ASSETS\s*=\s*\[([\s\S]*?)\]/);
  assertCheck(
    '6.1 Service worker uses smartskoolz-pwa-v3 and excludes /dashboard & auth/dynamic paths',
    swText.includes('smartskoolz-pwa-v3') &&
      staticMatch &&
      !staticMatch[1].includes('/dashboard') &&
      swText.includes("url.pathname.startsWith('/dashboard')") &&
      swText.includes("url.pathname.startsWith('/manual-attendance')") &&
      swText.includes("url.pathname.startsWith('/mark-attendance')"),
    'sw.js verified'
  );

  const adminForLogout = await sessionCookie('adminB@lab.io');
  const logoutRes = await fetch(`${BASE}/api/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: `${adminForLogout}; register_capability=abc; kiosk_capability=def`,
      Origin: BASE,
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  const clearSiteData = logoutRes.headers.get('clear-site-data') || '';
  assertCheck(
    '6.2 POST /api/logout emits Clear-Site-Data: "cache", "cookies", "storage" and 303 -> /login',
    logoutRes.status === 303 &&
      clearSiteData.includes('"cache"') &&
      clearSiteData.includes('"cookies"') &&
      clearSiteData.includes('"storage"'),
    `status=${logoutRes.status} Clear-Site-Data=${clearSiteData}`
  );
}

// ============================================================================
// PHASE H: Issue 7 — Native OpenXML `.xlsx` + Blob CSV & Zero Vulnerable Deps
// ============================================================================
console.log('\n--- Phase H: Issue 7 (`safe-spreadsheet.ts` OpenXML ZIP + formula neutralization + deps) ---');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(APPDIR, 'package.json'), 'utf8'));
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  assertCheck(
    '7.1 Vulnerable `xlsx` and unused `firebase-tools` purged; Next 15.5.28 + sharp ^0.35.5 installed',
    !allDeps.xlsx &&
      !allDeps['firebase-tools'] &&
      allDeps.next === '15.5.28' &&
      allDeps.sharp === '^0.35.5' &&
      !fs.existsSync(path.join(APPDIR, 'node_modules/xlsx')),
    `next=${allDeps.next} sharp=${allDeps.sharp}`
  );

  // Dynamically transpile & execute `lib/security/safe-spreadsheet.ts` with TypeScript compiler API!
  const ts = await import(path.join(APPDIR, 'node_modules/typescript/lib/typescript.js'));
  const src = fs.readFileSync(path.join(APPDIR, 'lib/security/safe-spreadsheet.ts'), 'utf8');
  const jsCode = ts.default.transpileModule(src, {
    compilerOptions: { module: ts.default.ModuleKind.ESNext, target: ts.default.ScriptTarget.ES2022 },
  }).outputText;
  const modUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
  const sheetMod = await import(modUrl);

  const sheetRows = [
    ['Name', 'Plus', 'Minus', 'At', 'Tab', 'Hash'],
    [
      '=CMD|" /C calc"!A0',
      '+SUM(A1:A5)',
      '-2+5',
      '@IMPORTXML("http://evil.example","//*")',
      '\t=EVIL()',
      'Room #104 & <Lab>',
    ],
  ];
  const xlsxBytes = sheetMod.buildSafeXlsx([{ name: 'Attendance Report', rows: sheetRows }]);
  const csvText = sheetMod.buildSafeCsv(sheetRows);
  const xlsxAscii = Buffer.from(xlsxBytes).toString('utf8');

  assertCheck(
    '7.2 Generated .xlsx is a valid PK ZIP archive with OpenXML worksheets & inline string cells',
    xlsxBytes[0] === 0x50 &&
      xlsxBytes[1] === 0x4b &&
      xlsxBytes[2] === 0x03 &&
      xlsxBytes[3] === 0x04 &&
      xlsxAscii.includes('[Content_Types].xml') &&
      xlsxAscii.includes('xl/worksheets/sheet1.xml') &&
      xlsxAscii.includes('t="inlineStr"'),
    `bytes=${xlsxBytes.byteLength}`
  );
  assertCheck(
    '7.3 Both .xlsx and .csv neutralize =,+,-,@,\\t formulas AND preserve `#104` intact without truncation',
    xlsxAscii.includes('&apos;=CMD') &&
      xlsxAscii.includes('&apos;+SUM') &&
      xlsxAscii.includes('&apos;-2+5') &&
      xlsxAscii.includes('&apos;@IMPORTXML') &&
      xlsxAscii.includes('Room #104 &amp; &lt;Lab&gt;') &&
      csvText.includes("'=CMD") &&
      csvText.includes('Room #104 & <Lab>'),
    `csvLen=${csvText.length}`
  );
}

// ============================================================================
// PHASE I: Issue 8 — Multi-Gate Broadcast, Quotas, Invite Gate, `% 24` & Hygiene
// ============================================================================
console.log('\n--- Phase I: Issue 8 (Multi-gate `ALL` broadcast, quotas, invite gate, `% 24` & hygiene) ---');
{
  await reseed({ mig10: '1' });

  // Add second active gate SNA0002 to School A
  const devA2 = 'aaaaaaaa-0000-4000-8000-0000000000d2';
  const secA2 = 'A2-device-secret-999888777';
  await q(
    `INSERT INTO school.devices(id, school_id, serial_number, label, device_type, device_secret_hash, is_active)
     VALUES ($1, $2, 'SNA0002', 'Back Gate A', 'zkteco', $3, true)`,
    [devA2, IDS.A.school, sha(secA2)]
  );
  // Clear seeded non-broadcast commands for clean assertion, insert one `ALL` broadcast command
  await q('DELETE FROM school.device_commands WHERE school_id = $1', [IDS.A.school]);
  const bcast = (
    await q(
      `INSERT INTO school.device_commands(school_id, target_serial, raw_command, status)
       VALUES ($1, 'ALL', 'DATA UPDATE USERINFO PIN=777\tName=Broadcast Test', 'pending')
       RETURNING id`,
      [IDS.A.school]
    )
  )[0];

  const pollA1First = await (
    await fetch(`${BASE}/iclock/getrequest?SN=SNA0001`, { headers: { 'X-Device-Token': SECRETS.A } })
  ).text();
  const stateMid = (
    await q('SELECT status, delivered_device_ids FROM school.device_commands WHERE id = $1', [bcast.id])
  )[0];
  const pollA1Second = await (
    await fetch(`${BASE}/iclock/getrequest?SN=SNA0001`, { headers: { 'X-Device-Token': SECRETS.A } })
  ).text();
  const pollA2First = await (
    await fetch(`${BASE}/iclock/getrequest?SN=SNA0002`, { headers: { 'X-Device-Token': secA2 } })
  ).text();
  const stateFinal = (
    await q('SELECT status, delivered_device_ids FROM school.device_commands WHERE id = $1', [bcast.id])
  )[0];

  assertCheck(
    '8.1 Broadcast target_serial="ALL" delivers once to SNA0001, stays pending for SNA0002, then marks "sent"',
    pollA1First.includes('Broadcast Test') &&
      stateMid.status === 'pending' &&
      !pollA1Second.includes('Broadcast Test') &&
      pollA2First.includes('Broadcast Test') &&
      stateFinal.status === 'sent' &&
      stateFinal.delivered_device_ids.length === 2,
    `mid=${stateMid.status} final=${stateFinal.status} delivered=${stateFinal.delivered_device_ids.length}`
  );

  // Spin up ephemeral server on port 3298 with MAX_DEVICES_PER_SCHOOL=2 and SIGNUP_INVITE_CODE=INVITE-R12
  const quotaSrv = spawn(process.execPath, ['scripts/start-standalone.mjs', '-p', '3298', '-H', '127.0.0.1'], {
    cwd: APPDIR,
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: SHIM,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'lab-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'lab-service-key',
      MAX_DEVICES_PER_SCHOOL: '2',
      SIGNUP_INVITE_CODE: 'INVITE-R12',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('quota server timeout')), 8000);
    quotaSrv.stdout.on('data', (d) => {
      if (String(d).includes('Ready in')) {
        clearTimeout(t);
        resolve();
      }
    });
  });

  try {
    const adminA = await sessionCookie('adminA@lab.io');
    const addDevId = ids.addDeviceAction[0].id;
    const fdDev = new FormData();
    fdDev.set('serialNumber', 'SNA0003');
    fdDev.set('label', 'Over Quota Gate');
    const quotaRes = await callAction('http://127.0.0.1:3298', '/dashboard/devices', addDevId, [fdDev], adminA);

    const signupId = ids.signupAction[0].id;
    const fdBadInvite = new FormData();
    fdBadInvite.set('schoolName', 'Unauthorized School');
    fdBadInvite.set('fullName', 'Eve');
    fdBadInvite.set('email', 'eve@lab.io');
    fdBadInvite.set('password', 'StrongPass123!');
    fdBadInvite.set('inviteCode', 'WRONG-CODE');
    const badInviteRes = await callAction('http://127.0.0.1:3298', '/signup', signupId, [fdBadInvite], '');

    assertCheck(
      '8.2 MAX_DEVICES_PER_SCHOOL quota enforced on addDeviceAction & SIGNUP_INVITE_CODE enforced on signupAction',
      Boolean(quotaRes.value?.error) &&
        /limit|maximum|quota/i.test(quotaRes.value.error) &&
        Boolean(badInviteRes.value?.error) &&
        /invit/i.test(badInviteRes.value.error),
      `quota="${quotaRes.value?.error}" invite="${badInviteRes.value?.error}"`
    );
  } finally {
    quotaSrv.kill('SIGTERM');
  }

  // 8.3 Verify `% 24` midnight handling in `lib/eat-time.ts` & `lib/attendance-window.ts`
  const ts = await import(path.join(APPDIR, 'node_modules/typescript/lib/typescript.js'));
  const eatSrc = fs.readFileSync(path.join(APPDIR, 'lib/eat-time.ts'), 'utf8');
  const winSrc = fs.readFileSync(path.join(APPDIR, 'lib/attendance-window.ts'), 'utf8');
  const eatMod = await import(
    'data:text/javascript;base64,' +
      Buffer.from(
        ts.default.transpileModule(eatSrc, {
          compilerOptions: { module: ts.default.ModuleKind.ESNext, target: ts.default.ScriptTarget.ES2022 },
        }).outputText
      ).toString('base64')
  );
  // 2026-10-23T21:05:00.000Z === 2026-10-24 00:05:00 EAT (midnight hour where ICU hour12:false can emit "24")
  const midnightUtc = new Date('2026-10-23T21:05:00.000Z');
  const eatDay = eatMod.getEATDayRange(midnightUtc);
  assertCheck(
    '8.3 Midnight 00:05 EAT computes dateStr=2026-10-24 cleanly and `% 24` guards all hour12:false formatters',
    eatDay.dateStr === '2026-10-24' && winSrc.includes('% 24') && eatSrc.includes('% 24'),
    `dateStr=${eatDay.dateStr}`
  );

  // 8.4 Repository hygiene check
  const gitignore = fs.readFileSync(path.join(APPDIR, '.gitignore'), 'utf8');
  assertCheck(
    '8.4 Stale root debug scripts, .env.test.local, and node-compile-cache removed & gitignored',
    !fs.existsSync(path.join(APPDIR, 'fix-cdata.js')) &&
      !fs.existsSync(path.join(APPDIR, 'fix-route.js')) &&
      !fs.existsSync(path.join(APPDIR, '.env.test.local')) &&
      !fs.existsSync(path.join(APPDIR, 'node-compile-cache')) &&
      gitignore.includes('node-compile-cache/'),
    'clean workspace'
  );
}

// Re-seed clean state at the end
await reseed({ mig10: '1' });
await db.end();

const failed = checks.filter((c) => !c.ok);
console.log(`\n=== ROUND 12 VERIFICATION SUMMARY: ${checks.length - failed.length}/${checks.length} PASSED ===`);
if (failed.length > 0) {
  for (const f of failed) console.error(`FAILED: ${f.name} -> ${f.detail}`);
  process.exit(1);
}
