// End-to-end ZKTeco duplicate-punch regression. Usage:
//   PGRST_TS=1 RLS=1 node double-thumb-check.mjs http://127.0.0.1:3201 before
// The shim must be started with PGRST_TS=1. MIG09=0 disables only the DB guard.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [BASE = 'http://127.0.0.1:3201', LABEL = 'run'] = process.argv.slice(2);
const SHIM = 'http://127.0.0.1:54321';
const SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000001';
const STUDENT = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const STUDENT_2 = 'aaaaaaaa-0000-4000-8000-0000000000f2';
const DEVICE_SECRET = 'A-device-secret-0123456789';
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const results = [];

const env = { ...process.env, RLS: process.env.RLS || '1' };
execFileSync(process.execPath, [path.join(__dirname, 'seed.js')], {
  cwd: __dirname,
  env,
  stdio: 'inherit',
});
const reload = await fetch(`${SHIM}/__reload`, { method: 'POST' });
if (!reload.ok) throw new Error(`Could not reload shim catalog: HTTP ${reload.status}`);

const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
await db.query(
  `INSERT INTO school.people (id, school_id, full_name, role, device_user_id)
   VALUES ($1, $2, 'Double-thumb student 2', 'student', '103')
   ON CONFLICT (id) DO NOTHING`,
  [STUDENT_2, SCHOOL],
);

function eatStamp(epochMs) {
  return new Date(epochMs + EAT_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}
function eatAt(hour, minute = 0, dayOffset = 0) {
  const shifted = new Date(Date.now() + EAT_OFFSET_MS + dayOffset * 24 * 60 * 60_000);
  const date = shifted.toISOString().slice(0, 10);
  return Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`);
}
const line = (pin, epochMs, type = 'check_in') =>
  `${pin}\t${eatStamp(epochMs)}\t${type === 'check_out' ? '1' : '0'}\t1`;

async function upload(lines) {
  const response = await fetch(
    `${BASE}/iclock/cdata?${new URLSearchParams({ SN: 'SNA0001', table: 'ATTLOG', token: DEVICE_SECRET })}`,
    { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `${lines.join('\n')}\n` },
  );
  const body = await response.text();
  return { status: response.status, body };
}
async function clearRows() {
  await db.query(`DELETE FROM school.attendance_logs WHERE source = 'device'`);
}
async function rowCount() {
  const { rows } = await db.query(
    `SELECT count(*)::int AS count, min(extract(epoch FROM occurred_at))::float8 AS first_epoch
       FROM school.attendance_logs WHERE school_id = $1`,
    [SCHOOL],
  );
  return { count: rows[0].count, firstEpoch: rows[0].first_epoch == null ? null : Number(rows[0].first_epoch) };
}
async function scenario(name, expected, run, keptAt) {
  await clearRows();
  const requestResult = await run();
  const requestResults = Array.isArray(requestResult) ? requestResult : [requestResult];
  const stored = await rowCount();
  const httpOk = requestResults.every((r) => r.status === 200 && r.body === 'OK');
  const keptOk = keptAt === undefined || (stored.firstEpoch != null && Math.abs(stored.firstEpoch - keptAt / 1000) < 0.001);
  const passed = stored.count === expected && httpOk && keptOk;
  const result = {
    scenario: name,
    expectedRows: expected,
    actualRows: stored.count,
    httpStatuses: requestResults.map((r) => r.status),
    keptOldestPunch: keptAt === undefined ? null : keptOk,
    passed,
  };
  results.push(result);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${stored.count}/${expected} rows; HTTP ${result.httpStatuses.join(',')}${keptAt === undefined ? '' : `; oldest kept ${keptOk ? 'yes' : 'no'}`}`);
}

// A fresh, past timestamp with second precision, accepted by the processor's
// clock-skew guard and far enough from test-to-test traffic.
const base = Math.floor((Date.now() - 5 * 60_000) / 1000) * 1000;

await scenario('Same second twice in one upload', 1, () => upload([line('102', base), line('102', base)]));
await scenario('Same punch re-sent in a later upload', 1, async () => [
  await upload([line('102', base + 10_000)]),
  await upload([line('102', base + 10_000)]),
]);
await scenario('Same punch sent 5x in parallel', 1, () => Promise.all(
  Array.from({ length: 5 }, () => upload([line('102', base + 20_000)])),
));
await scenario('Two thumbs 2 seconds apart in one upload (newer arrives first)', 1,
  () => upload([line('102', base + 32_000), line('102', base + 30_000)]), base + 30_000);
await scenario('Two thumbs 2 seconds apart in separate uploads', 1, async () => [
  await upload([line('102', base + 40_000)]),
  await upload([line('102', base + 42_000)]),
], base + 40_000);
await scenario('Two thumbs 40 seconds apart', 1,
  () => upload([line('102', base + 90_000), line('102', base + 50_000)]), base + 50_000);
await scenario('Check-in then check-out 1 minute later', 2, () => upload([
  line('102', base + 100_000, 'check_in'),
  line('102', base + 160_000, 'check_out'),
]));
await scenario('Same child 3 minutes later in the same direction', 2, () => upload([
  line('102', base + 200_000, 'check_in'),
  line('102', base + 380_000, 'check_in'),
]));
await scenario('Two different students at the same second', 2, () => upload([
  line('102', base + 400_000),
  line('103', base + 400_000),
]));
const todayEAT = new Date(Date.now() + EAT_OFFSET_MS);
const attendanceDayOffset = todayEAT.getHours() < 14 ? -1 : 0;
await scenario('Morning check-in and afternoon check-out', 2, () => upload([
  line('102', eatAt(7, 30, attendanceDayOffset), 'check_in'),
  line('102', eatAt(14, 0, attendanceDayOffset), 'check_out'),
]));

await clearRows();
const migrationStatus = await db.query("SELECT to_regclass('school.attendance_logs_device_punch_once') IS NOT NULL AS enabled");
await db.end();
const passed = results.filter((r) => r.passed).length;
const report = { label: LABEL, duplicateWindowSeconds: process.env.ATTENDANCE_DUPLICATE_WINDOW_SECONDS ?? 'default (120)', migration09Enabled: migrationStatus.rows[0].enabled, passed, total: results.length, results };
const out = path.join(__dirname, `double-thumb-results-${LABEL}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`\n[${LABEL}] ${passed}/${results.length} scenarios passed; wrote ${out}`);
if (passed !== results.length) process.exitCode = 1;
