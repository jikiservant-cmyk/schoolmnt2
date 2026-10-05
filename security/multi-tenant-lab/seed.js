// Seeds two tenants (A = attacker, B = victim) into the mtlab database.
const { Client } = require('pg');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('/home/user/schoolmnt2/node_modules/bcryptjs');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const IDS = {
  A: { school: 'aaaaaaaa-0000-4000-8000-000000000001', admin: 'aaaaaaaa-0000-4000-8000-0000000000a1', cls: 'aaaaaaaa-0000-4000-8000-0000000000c1',
       teacher: 'aaaaaaaa-0000-4000-8000-0000000000e1', student: 'aaaaaaaa-0000-4000-8000-0000000000f1', device: 'aaaaaaaa-0000-4000-8000-0000000000d1',
       parent: 'aaaaaaaa-0000-4000-8000-0000000000b1' },
  B: { school: 'bbbbbbbb-0000-4000-8000-000000000001', admin: 'bbbbbbbb-0000-4000-8000-0000000000a1', cls: 'bbbbbbbb-0000-4000-8000-0000000000c1',
       teacher: 'bbbbbbbb-0000-4000-8000-0000000000e1', student: 'bbbbbbbb-0000-4000-8000-0000000000f1', device: 'bbbbbbbb-0000-4000-8000-0000000000d1',
       parent: 'bbbbbbbb-0000-4000-8000-0000000000b1' },
};
const SECRETS = { A: 'A-device-secret-0123456789', B: 'B-device-secret-9876543210' };
module.exports = { IDS, SECRETS };

if (require.main === module) (async () => {
  const admin = new Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname='mtlab'");
  if (!exists.rowCount) await admin.query('CREATE DATABASE mtlab');
  await admin.end();
  const c = new Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
  await c.connect();
  await c.query(fs.readFileSync(__dirname + '/schema.sql', 'utf8'));
  for (const [k, t] of Object.entries(IDS)) {
    const name = k === 'A' ? 'Alpha Academy' : 'Bravo College';
    await c.query("INSERT INTO school.schools(id,name,settings) VALUES ($1,$2,$3)", [t.school, name, JSON.stringify({ balance: 1000 })]);
    await c.query("INSERT INTO public.admin_profiles(id,role,app_type,school_id,email) VALUES ($1,'school_admin','school',$2,$3)", [t.admin, t.school, `admin${k}@lab.io`]);
    await c.query("INSERT INTO public.tenants(id,code,name) VALUES ($1,$2,$3)", [t.school, 'code' + k, name]);
    await c.query("INSERT INTO public.wallets(tenant_id,school_id,balance) VALUES ($1,$1,1000)", [t.school]);
    await c.query("INSERT INTO school.people(id,school_id,full_name,role,device_user_id,phone) VALUES ($1,$2,$3,'teacher',$4,'+256700000001')", [t.teacher, t.school, `Teacher ${k}-SECRETNAME`, k === 'A' ? '101' : '201']);
    await c.query("INSERT INTO school.classes(id,school_id,name,teacher_id) VALUES ($1,$2,$3,$4)", [t.cls, t.school, `Class ${k}-SECRETNAME`, t.teacher]);
    await c.query("INSERT INTO school.people(id,school_id,full_name,role,class_id,device_user_id) VALUES ($1,$2,$3,'student',$4,$5)", [t.student, t.school, `Student ${k}-SECRETNAME`, t.cls, k === 'A' ? '102' : '202']);
    await c.query("INSERT INTO school.parents(id,school_id,full_name,phone) VALUES ($1,$2,$3,$4)", [t.parent, t.school, `Parent ${k}`, k === 'A' ? '+256711111111' : '+256722222222']);
    await c.query("INSERT INTO school.student_parents(student_id,parent_id,is_primary_contact) VALUES ($1,$2,true)", [t.student, t.parent]);
    await c.query("INSERT INTO school.staff_users(school_id,auth_user_id,person_id,staff_role) VALUES ($1,$2,$3,'admin')", [t.school, t.admin, t.teacher]);
    if (k === 'A') await c.query("INSERT INTO school.staff_users(school_id,auth_user_id,person_id,staff_role) VALUES ($1,'aaaaaaaa-0000-4000-8000-0000000000a2',NULL,'teacher')", [t.school]);
    await c.query("UPDATE school.staff_users SET pin_hash=$1 WHERE person_id=$2", [bcrypt.hashSync(k === 'A' ? '482913' : '739164', 4), t.teacher]);
    await c.query("INSERT INTO school.devices(id,school_id,serial_number,label,device_type,device_secret_hash,is_active) VALUES ($1,$2,$3,$4,'zkteco',$5,true)",
      [t.device, t.school, 'SN' + k + '0001', 'Gate ' + k, sha(SECRETS[k])]);
    await c.query("INSERT INTO school.device_commands(school_id,device_id,target_serial,raw_command,status) VALUES ($1,$2,$3,$4,'pending')",
      [t.school, t.device, 'SN' + k + '0001', `DATA UPDATE USERINFO PIN=999\tName=${k}-SECRETCMD`]);
  }
  await c.query(fs.readFileSync(__dirname + '/supabase-base.sql', 'utf8'));
  if (process.env.PRODFN !== '0') await c.query(fs.readFileSync(__dirname + '/prod-like-functions.sql', 'utf8'));
  if (process.env.RLS === '1') {
    // Emulate a sloppy pre-existing setup: RLS on, plus a wide-open policy.
    await c.query("ALTER TABLE school.people ENABLE ROW LEVEL SECURITY; CREATE POLICY legacy_open ON school.people FOR SELECT TO authenticated USING (true)");
    const mig = '/home/user/schoolmnt2/supabase_migrations/';
    await c.query(fs.readFileSync(mig + '03_tenant_integrity.sql', 'utf8'));
    if (process.env.HARDEN !== '0') await c.query("SET smartskoolz.harden_public = 'on'");
    await c.query(fs.readFileSync(mig + '04_rls_tenant_isolation.sql', 'utf8'));
    if (process.env.MIG05 !== '0') await c.query(fs.readFileSync(mig + '05_sms_payment_integrity.sql', 'utf8'));
    if (process.env.MIG06 !== '0' && fs.existsSync(mig + '06_money_lockdown.sql')) await c.query(fs.readFileSync(mig + '06_money_lockdown.sql', 'utf8'));
    console.log('RLS migrations applied');
  }
  console.log('seeded');
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
