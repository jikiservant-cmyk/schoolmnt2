const EmbeddedPostgres = require('embedded-postgres').default;
const { Client } = require('pg');
const fs = require('fs');

(async () => {

  const c = new Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'postgres' });
  await c.connect();
  c.on('notice', (n) => console.log('  NOTICE:', n.message));
  await c.query(`
    CREATE SCHEMA school;
    CREATE TABLE school.schools(id uuid primary key);
    CREATE TABLE school.classes(id uuid primary key default gen_random_uuid(), school_id uuid references school.schools, name text, teacher_id uuid);
    CREATE TABLE school.people(id uuid primary key default gen_random_uuid(), school_id uuid references school.schools, full_name text, role text, class_id uuid references school.classes);
    ALTER TABLE school.classes ADD FOREIGN KEY (teacher_id) REFERENCES school.people;
    CREATE TABLE school.devices(id uuid primary key default gen_random_uuid(), school_id uuid, serial_number text);
    CREATE TABLE school.attendance_logs(id uuid primary key default gen_random_uuid(), school_id uuid, person_id uuid references school.people, device_id uuid);
    CREATE TABLE school.device_commands(id uuid primary key default gen_random_uuid(), school_id uuid, device_id uuid, target_serial text);
    CREATE TABLE school.parents(id uuid primary key default gen_random_uuid(), school_id uuid, phone text);
    CREATE TABLE school.student_parents(student_id uuid, parent_id uuid);
    CREATE TABLE school.notifications(id uuid primary key default gen_random_uuid(), school_id uuid, related_table text, related_id uuid);
  `);
  const sql = fs.readFileSync('/home/user/schoolmnt2/supabase_migrations/03_tenant_integrity.sql', 'utf8');
  await c.query(sql);
  console.log('migration applied; re-running for idempotency');
  await c.query(sql);

  const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
  await c.query(`INSERT INTO school.schools VALUES ($1),($2)`, [A, B]);
  const q1 = async (s, p) => (await c.query(s, p)).rows[0].id;
  const clsA = await q1(`INSERT INTO school.classes(school_id,name) VALUES ($1,'A1') RETURNING id`, [A]);
  const clsB = await q1(`INSERT INTO school.classes(school_id,name) VALUES ($1,'B1') RETURNING id`, [B]);
  const tA = await q1(`INSERT INTO school.people(school_id,role) VALUES ($1,'teacher') RETURNING id`, [A]);
  const pB = await q1(`INSERT INTO school.people(school_id,role) VALUES ($1,'student') RETURNING id`, [B]);
  const devB = await q1(`INSERT INTO school.devices(school_id,serial_number) VALUES ($1,'SNB') RETURNING id`, [B]);
  const devA = await q1(`INSERT INTO school.devices(school_id,serial_number) VALUES ($1,'SNA') RETURNING id`, [A]);
  const parB = await q1(`INSERT INTO school.parents(school_id) VALUES ($1) RETURNING id`, [B]);
  const sA = await q1(`INSERT INTO school.people(school_id,role,class_id) VALUES ($1,'student',$2) RETURNING id`, [A, clsA]);
  const logB = await q1(`INSERT INTO school.attendance_logs(school_id,person_id,device_id) VALUES ($1,$2,$3) RETURNING id`, [B, pB, devB]);

  let pass = 0, fail = 0;
  const expect = async (name, shouldPass, s, p) => {
    try { await c.query(s, p); if (shouldPass) { pass++; console.log('OK   ', name); } else { fail++; console.log('FAIL (allowed)', name); } }
    catch (e) { if (!shouldPass) { pass++; console.log('OK   ', name, '->', e.message.slice(0, 80)); } else { fail++; console.log('FAIL (blocked)', name, e.message); } }
  };
  await expect('A student into B class', false, `INSERT INTO school.people(school_id,class_id) VALUES ($1,$2)`, [A, clsB]);
  await expect('A student into A class', true, `INSERT INTO school.people(school_id,class_id) VALUES ($1,$2)`, [A, clsA]);
  await expect('update A student to B class', false, `UPDATE school.people SET class_id=$1 WHERE id=$2`, [clsB, sA]);
  await expect('A class with B teacher', false, `INSERT INTO school.classes(school_id,teacher_id) VALUES ($1,$2)`, [A, pB]);
  await expect('A class with A teacher', true, `INSERT INTO school.classes(school_id,teacher_id) VALUES ($1,$2)`, [A, tA]);
  await expect('A log on B person', false, `INSERT INTO school.attendance_logs(school_id,person_id) VALUES ($1,$2)`, [A, pB]);
  await expect('A log on B device', false, `INSERT INTO school.attendance_logs(school_id,person_id,device_id) VALUES ($1,$2,$3)`, [A, sA, devB]);
  await expect('A log ok', true, `INSERT INTO school.attendance_logs(school_id,person_id,device_id) VALUES ($1,$2,$3)`, [A, sA, devA]);
  await expect('A cmd on B device', false, `INSERT INTO school.device_commands(school_id,device_id,target_serial) VALUES ($1,$2,'SNB')`, [A, devB]);
  await expect('A cmd ALL (null device)', true, `INSERT INTO school.device_commands(school_id,device_id,target_serial) VALUES ($1,NULL,'ALL')`, [A]);
  await expect('A student + B parent', false, `INSERT INTO school.student_parents VALUES ($1,$2)`, [sA, parB]);
  await expect('A notif -> B log', false, `INSERT INTO school.notifications(school_id,related_table,related_id) VALUES ($1,'attendance_logs',$2)`, [A, logB]);
  await expect('A notif other table', true, `INSERT INTO school.notifications(school_id,related_table,related_id) VALUES ($1,'transactions',$2)`, [A, logB]);
  await expect('move person to B school', false, `UPDATE school.people SET school_id=$1 WHERE id=$2`, [B, sA]);
  await expect('rename person (no tenant change)', true, `UPDATE school.people SET full_name='x' WHERE id=$1`, [sA]);
  await expect('duplicate serial other case', false, `INSERT INTO school.devices(school_id,serial_number) VALUES ($1,'sna')`, [B]);
  console.log(`\n${pass} passed, ${fail} failed`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
