// Device-surface pentest. Usage: node device-attack.mjs <base> <label>
import pg from 'pg';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
const [BASE, LABEL] = process.argv.slice(2);
const SHIM = 'http://127.0.0.1:54321';
const A_SCHOOL = 'aaaaaaaa-0000-4000-8000-000000000001';
const A_SECRET = 'A-device-secret-0123456789';
const GEN_SECRET = 'A-generic-secret-0123456789';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const results = [];
const rec = (name, vuln, detail) => { results.push({ name, vulnerable: vuln, detail: String(detail ?? '') }); console.log((vuln ? 'VULNERABLE ' : 'secure     ') + name + '  [' + String(detail ?? '').slice(0, 150) + ']'); };

execSync('node seed.js', { cwd: '/home/user/mt-lab' });
const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
// Extra fixtures: a generic-webhook device, an inactive student with a guardian.
await q("INSERT INTO school.devices(school_id,serial_number,label,device_type,device_secret_hash,is_active) VALUES ($1,'SNA0002','Side gate','generic_webhook',$2,true)", [A_SCHOOL, sha(GEN_SECRET)]);
await q("INSERT INTO school.devices(school_id,serial_number,label,device_type,device_secret_hash,is_active) VALUES ($1,'SNA0003','Old gate','zkteco_adms',$2,false)", [A_SCHOOL, sha(A_SECRET)]);
const inactive = (await q("INSERT INTO school.people(school_id,full_name,role,device_user_id,is_active) VALUES ($1,'Expelled Kid','student','103',false) RETURNING id", [A_SCHOOL]))[0].id;
const par = (await q("INSERT INTO school.parents(school_id,full_name,phone) VALUES ($1,'P','+256733333333') RETURNING id", [A_SCHOOL]))[0].id;
await q("INSERT INTO school.student_parents(student_id,parent_id,is_primary_contact) VALUES ($1,$2,true)", [inactive, par]);
await fetch(SHIM + '/__reload', { method: 'POST' });
const STUDENT = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const ic = (path, qs, init = {}) => fetch(BASE + path + '?' + new URLSearchParams(qs), init);
const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // EAT date
// D1 serial enumeration via different error messages
{
  const a = await (await ic('/iclock/cdata', { SN: 'NOPE9999', token: 'x' })).text();
  const b = await (await ic('/iclock/cdata', { SN: 'SNA0001', token: 'wrong' })).text();
  const c = await (await ic('/iclock/cdata', { SN: 'SNA0003', token: A_SECRET })).text();
  rec('D1 cdata error text reveals whether a serial exists / is deactivated', a !== b || b !== c, `${a} | ${b} | ${c}`);
  const d = await (await ic('/iclock/getrequest', { SN: 'NOPE9999', token: 'x' })).text();
  const e = await (await ic('/iclock/getrequest', { SN: 'SNA0001', token: 'wrong' })).text();
  rec('D1b getrequest error text reveals whether a serial exists', d !== e, `${d} | ${e}`);
}
// D2 no brute-force throttling on device secrets
{
  let limited = false;
  for (let i = 0; i < 60; i++) {
    const r = await ic('/iclock/cdata', { SN: 'SNA0001', token: 'guess' + i }, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    if (r.status === 429) { limited = true; break; }
  }
  rec('D2 unlimited device-secret guessing (60 tries, no 429)', !limited, limited ? 'throttled' : 'never throttled');
  const ok = await ic('/iclock/cdata', { SN: 'SNA0001', token: A_SECRET }, { headers: { 'x-forwarded-for': '198.51.100.7' } });
  rec('D2b (baseline) real device from another IP still works', ok.status !== 200, ok.status);
}
// D3 oversized unauthenticated bodies
{
  const big = 'x'.repeat(8 * 1024 * 1024);
  for (const p of ['/api/devices/push', '/iclock/devicecmd']) {
    const r = await ic(p, { SN: 'NOPE9999' }, { method: 'POST', body: big });
    // 401 before the body is read is as good as 413 (nothing is buffered).
    rec(`D3 ${p}: 8MB unauthenticated body not rejected (413/401-before-read)`, p === '/api/devices/push' ? r.status !== 413 : ![401, 413].includes(r.status), r.status);
  }
  const ra = await ic('/iclock/cdata', { SN: 'SNA0001', table: 'ATTLOG', token: A_SECRET }, { method: 'POST', body: big });
  rec('D3b /iclock/cdata: 8MB body from an authenticated device not rejected', ra.status !== 413, ra.status);
}
// D4 far-future / ancient timestamps from a webhook device
const gen = (body) => ic('/api/devices/push', { sn: 'SNA0002' }, { method: 'POST', body: JSON.stringify(body), headers: { 'x-device-token': GEN_SECRET, 'content-type': 'application/json' } });
{
  await gen({ pin: '102', timestamp: '2099-01-01T07:00:00Z' });
  await gen({ pin: '102', timestamp: '1999-01-01T07:00:00Z' });
  const rows = await q("SELECT occurred_at FROM school.attendance_logs WHERE person_id=$1 AND (occurred_at > now() + interval '1 day' OR occurred_at < now() - interval '90 days')", [STUDENT]);
  rec('D4 webhook device can write attendance dated 2099 / 1999', rows.length > 0, rows.map((r) => r.occurred_at.toISOString()).join(','));
}
{
  const line = `103\t${today} 07:10:00\t0\t1\n`;
  await ic('/iclock/cdata', { SN: 'SNA0001', table: 'ATTLOG', token: A_SECRET }, { method: 'POST', body: line });
  const att = await q("SELECT id FROM school.attendance_logs WHERE person_id=$1", [inactive]);
  rec('D5 deactivated student still recorded by device', att.length > 0, att.length);
}
// D6 SMS flood: one student, 5 punches in the morning window
{
  await q("DELETE FROM school.notifications");
  let body = '';
  for (let m = 0; m < 5; m++) body += `102\t${today} 07:2${m}:00\t0\t1\n`;
  await ic('/iclock/cdata', { SN: 'SNA0001', table: 'ATTLOG', token: A_SECRET }, { method: 'POST', body });
  const n = (await q("SELECT count(*)::int n FROM school.notifications WHERE recipient_phone_snapshot='+256711111111'"))[0].n;
  rec('D6 repeated punches send repeated paid SMS to the parent', n > 1, n + ' SMS for 5 punches');
}
// D7 non-attendance tables parsed as punches
{
  const before = (await q("SELECT count(*)::int n FROM school.attendance_logs"))[0].n;
  const body = `102\t${today} 06:40:00\t0\t1\n`;
  await ic('/iclock/cdata', { SN: 'SNA0001', table: 'OPERLOG', token: A_SECRET }, { method: 'POST', body });
  const after = (await q("SELECT count(*)::int n FROM school.attendance_logs"))[0].n;
  rec('D7 OPERLOG/USERINFO uploads treated as attendance', after > before, `${before}->${after}`);
}
// D8 a queued command containing a newline smuggles extra ADMS commands
{
  await q("INSERT INTO school.device_commands(school_id,target_serial,raw_command,status) VALUES ($1,'SNA0001',$2,'pending')", [A_SCHOOL, 'DATA UPDATE userinfo PIN=5\tName=x\nC:999:CLEAR ALL DATA']);
  const t = await (await ic('/iclock/getrequest', { SN: 'SNA0001', token: A_SECRET })).text();
  rec('D8 getrequest relays newline-smuggled command (CLEAR ALL DATA)', t.includes('C:999:CLEAR ALL DATA'), t.replace(/\n/g, ' | ').slice(0, 120));
}
// D9 database failure is acknowledged as OK (device deletes its buffered punches)
{
  // Any write fails; the punch is from 2 minutes ago so it is valid at any time of day
  // (a fixed 15:00 was "in the future" and dropped before the write in the morning).
  await q("ALTER TABLE school.attendance_logs ADD CONSTRAINT lab_fail CHECK (false) NOT VALID");
  const recent = new Date(Date.now() + 3 * 3600e3 - 120e3).toISOString().slice(0, 19).replace('T', ' ');
  const r = await ic('/iclock/cdata', { SN: 'SNA0001', table: 'ATTLOG', token: A_SECRET }, { method: 'POST', body: `102\t${recent}\t1\t1\n` });
  await q("ALTER TABLE school.attendance_logs DROP CONSTRAINT lab_fail");
  rec('D9 failed DB write still answered "OK" (punches lost forever)', r.status === 200, r.status + ' ' + (await r.text()).slice(0, 40));
}
// D10 baseline: legit flows must keep working
{
  await q("DELETE FROM school.attendance_logs");
  const r1 = await ic('/iclock/cdata', { SN: 'sna0001', table: 'ATTLOG', token: A_SECRET }, { method: 'POST', body: `102\t${today} 07:45:00\t0\t1\n` });
  const r2 = await gen({ pin: '101', timestamp: new Date().toISOString(), event_type: 'check_out' });
  const r3 = await ic('/iclock/devicecmd', { SN: 'SNA0001', token: A_SECRET }, { method: 'POST', body: 'ID=00000000-0000-4000-8000-000000000000&Return=0&CMD=DATA\n' });
  const n = (await q("SELECT count(*)::int n FROM school.attendance_logs"))[0].n;
  rec('D10 (baseline) legit ZKTeco + webhook punches + ack work', !(r1.status === 200 && r2.status === 200 && r3.status === 200 && n === 2), `${r1.status}/${r2.status}/${r3.status} rows=${n}`);
  const h = await ic('/iclock/cdata', { SN: 'SNA0001', token: A_SECRET });
  rec('D10b (baseline) handshake works', h.status !== 200, h.status);
}
await db.end();
const v = results.filter((r) => r.vulnerable).length;
console.log(`\n[${LABEL}] ${v} vulnerable / ${results.length} checks`);
fs.writeFileSync(`/home/user/mt-lab/device-results-${LABEL}.json`, JSON.stringify(results, null, 2));
