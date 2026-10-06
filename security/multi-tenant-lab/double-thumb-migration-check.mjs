// Tests migration 09 independently. Usage: RLS=1 node double-thumb-migration-check.mjs
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000001';
const PERSON = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const migrationPath = path.resolve(__dirname, '../../supabase_migrations/09_attendance_duplicate_guard.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const env = { ...process.env, RLS: '1', MIG09: '0' };
execFileSync(process.execPath, [path.join(__dirname, 'seed.js')], { cwd: __dirname, env, stdio: 'inherit' });
const reload = await fetch('http://127.0.0.1:54321/__reload', { method: 'POST' });
if (!reload.ok) throw new Error(`Could not reload shim catalog: HTTP ${reload.status}`);

const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, passed: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}
const exactAt = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
const nearbyAt = new Date(new Date(exactAt).getTime() + 2_000).toISOString();
const manualAt = new Date(new Date(exactAt).getTime() + 5_000).toISOString();
const inserted = await db.query(
  `INSERT INTO school.attendance_logs (school_id, person_id, source, occurred_at, attendance_type)
   VALUES
     ($1, $2, 'device', $3, 'check_in'),
     ($1, $2, 'device', $3, 'check_in'),
     ($1, $2, 'device', $3, 'check_in'),
     ($1, $2, 'device', $4, 'check_in'),
     ($1, $2, 'device', $5, 'check_in'),
     ($1, $2, 'manual', $6, 'check_in'),
     ($1, $2, 'manual', $6, 'check_in')
   RETURNING id, source, occurred_at`,
  [SCHOOL, PERSON, exactAt, nearbyAt, new Date(new Date(exactAt).getTime() + 4_000).toISOString(), manualAt],
);
const originalExactIds = inserted.rows.filter((row) => row.source === 'device' && new Date(row.occurred_at).getTime() === new Date(exactAt).getTime()).map((row) => row.id).sort();
const survivorId = originalExactIds[0];
const duplicateIds = originalExactIds.slice(1).sort();
const notices = [];
db.on('notice', (notice) => notices.push(notice.message));

await db.query(migration);
const activeExact = await db.query(
  `SELECT id FROM school.attendance_logs WHERE source = 'device' AND person_id = $1 AND occurred_at = $2`,
  [PERSON, exactAt],
);
const archivedExact = await db.query(
  `SELECT id, removed_at FROM school.attendance_logs_duplicates_backup WHERE source = 'device' AND person_id = $1 AND occurred_at = $2 ORDER BY id`,
  [PERSON, exactAt],
);
check('archives exact device duplicates and keeps the lowest id',
  activeExact.rowCount === 1 && activeExact.rows[0].id === survivorId &&
  archivedExact.rowCount === 2 && archivedExact.rows.map((row) => row.id).sort().join(',') === duplicateIds.join(',') &&
  archivedExact.rows.every((row) => row.removed_at != null),
  `active=${activeExact.rowCount}, backup=${archivedExact.rowCount}`);
const nearCount = await db.query(
  `SELECT count(*)::int AS count FROM school.attendance_logs WHERE source = 'device' AND person_id = $1 AND occurred_at IN ($2, $3)`,
  [PERSON, nearbyAt, new Date(new Date(exactAt).getTime() + 4_000).toISOString()],
);
check('leaves device punches seconds apart untouched', nearCount.rows[0].count === 2, `remaining=${nearCount.rows[0].count}`);
const manualCount = await db.query(
  `SELECT count(*)::int AS count FROM school.attendance_logs WHERE source = 'manual' AND person_id = $1 AND occurred_at = $2`,
  [PERSON, manualAt],
);
check('leaves manual duplicate rows untouched', manualCount.rows[0].count === 2, `remaining=${manualCount.rows[0].count}`);
check('migration reports the number archived', notices.some((message) => /Moved 2 exact duplicate device attendance row/.test(message)), notices.join(' | '));

const backupBeforeSecondRun = await db.query('SELECT count(*)::int AS count FROM school.attendance_logs_duplicates_backup');
notices.length = 0;
await db.query(migration);
const backupAfterSecondRun = await db.query('SELECT count(*)::int AS count FROM school.attendance_logs_duplicates_backup');
check('migration is safe to run twice', backupBeforeSecondRun.rows[0].count === 2 && backupAfterSecondRun.rows[0].count === 2,
  `backup=${backupBeforeSecondRun.rows[0].count}->${backupAfterSecondRun.rows[0].count}`);

let deviceConflictCode = null;
try {
  await db.query(
    `INSERT INTO school.attendance_logs (school_id, person_id, source, occurred_at, attendance_type)
     VALUES ($1, $2, 'device', $3, 'check_in')`,
    [SCHOOL, PERSON, exactAt],
  );
} catch (error) {
  deviceConflictCode = error.code;
}
check('unique index refuses a repeated device punch', deviceConflictCode === '23505', `error=${deviceConflictCode}`);

const manualDuplicateAt = new Date(new Date(exactAt).getTime() + 10_000).toISOString();
await db.query(
  `INSERT INTO school.attendance_logs (school_id, person_id, source, occurred_at, attendance_type)
   VALUES ($1, $2, 'manual', $3, 'check_in'), ($1, $2, 'manual', $3, 'check_in')`,
  [SCHOOL, PERSON, manualDuplicateAt],
);
const manualAfterIndex = await db.query(
  `SELECT count(*)::int AS count FROM school.attendance_logs WHERE source = 'manual' AND person_id = $1 AND occurred_at = $2`,
  [PERSON, manualDuplicateAt],
);
check('unique index does not restrict manual attendance', manualAfterIndex.rows[0].count === 2, `inserted=${manualAfterIndex.rows[0].count}`);

const backupSettings = await db.query(
  `SELECT c.relrowsecurity,
          (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'school' AND p.tablename = 'attendance_logs_duplicates_backup') AS policy_count
     FROM pg_class c WHERE c.oid = 'school.attendance_logs_duplicates_backup'::regclass`,
);
check('backup is protected by RLS with no policies', backupSettings.rows[0].relrowsecurity && backupSettings.rows[0].policy_count === 0,
  `rls=${backupSettings.rows[0].relrowsecurity}, policies=${backupSettings.rows[0].policy_count}`);
const appPrivileges = [];
for (const role of ['anon', 'authenticated']) {
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    const { rows } = await db.query('SELECT has_table_privilege($1, $2, $3) AS allowed', [role, 'school.attendance_logs_duplicates_backup', privilege]);
    if (rows[0].allowed) appPrivileges.push(`${role}:${privilege}`);
  }
}
check('backup has no app-role grants', appPrivileges.length === 0, appPrivileges.join(', ') || 'anon/authenticated have no table privileges');

await db.end();
const passed = checks.filter((result) => result.passed).length;
const report = { passed, total: checks.length, checks };
const out = path.join(__dirname, 'double-thumb-migration-results.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`\n[migration 09] ${passed}/${checks.length} checks passed; wrote ${out}`);
if (passed !== checks.length) process.exitCode = 1;
