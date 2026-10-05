// 03 trigger: a row written with school_id NULL inherits the school of the row
// it points at. Make sure this can't be used to write into another school.
// Run after: RLS=1 node seed.js
const { Client } = require('pg');
const { IDS } = require('./seed.js');
(async () => {
  const c = new Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
  await c.connect();
  let pass = 0, fail = 0;
  const ok = (name, cond, d) => { cond ? pass++ : fail++; console.log((cond ? 'OK   ' : 'FAIL ') + name + (d ? '  -> ' + d : '')); };
  // 1. Server (service role) writes a log without school_id -> inherits device's school.
  const r = await c.query("INSERT INTO school.device_logs(device_id, raw_data) VALUES ($1, 'svc-null') RETURNING school_id", [IDS.B.device]);
  ok('service insert with NULL school inherits device school', r.rows[0].school_id === IDS.B.school, r.rows[0].school_id);
  // 2. Admin A (authenticated) tries the same against B's device -> must be rejected.
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE authenticated');
  await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: IDS.A.admin, role: 'authenticated' })]);
  try {
    await c.query("INSERT INTO school.device_logs(device_id, raw_data) VALUES ($1, 'A-null-into-B')", [IDS.B.device]);
    ok('A insert with NULL school pointing at B device is rejected', false, 'inserted!');
  } catch (e) { ok('A insert with NULL school pointing at B device is rejected', true, e.message); }
  await c.query('ROLLBACK');
  // 3. Admin A with NULL school pointing at its own device -> allowed, gets A.
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE authenticated');
  await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: IDS.A.admin, role: 'authenticated' })]);
  try {
    const x = await c.query("INSERT INTO school.device_logs(device_id, raw_data) VALUES ($1, 'A-null-own') RETURNING school_id", [IDS.A.device]);
    ok('A insert with NULL school on own device gets school A', x.rows[0].school_id === IDS.A.school, x.rows[0].school_id);
  } catch (e) { ok('A insert with NULL school on own device gets school A', false, e.message); }
  await c.query('ROLLBACK');
  console.log(`\n${pass} passed, ${fail} failed`);
  await c.end();
  process.exit(fail ? 1 : 0);
})();
