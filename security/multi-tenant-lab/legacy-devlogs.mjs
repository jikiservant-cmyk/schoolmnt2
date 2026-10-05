// Older database without device_logs.school_id: punches must still be logged.
// Usage: node legacy-devlogs.mjs prep   (drop the column), then restart the shim
//        with SHIM_NO_AUTOCOL=1, then: node legacy-devlogs.mjs punch <base>
import pg from 'pg';
import crypto from 'crypto';
const db = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;
if (process.argv[2] === 'prep') {
  await q('DROP TRIGGER IF EXISTS trg_devlogs_device_same_tenant ON school.device_logs');
  await q('ALTER TABLE school.device_logs DROP COLUMN IF EXISTS school_id CASCADE');
  console.log('device_logs.school_id dropped');
} else {
  const BASE = process.argv[3];
  // regress.mjs rotates this secret; put the known one back.
  const SECRET = 'A-device-secret-0123456789';
  await q("UPDATE school.devices SET device_secret = NULL, device_secret_hash = $1 WHERE serial_number = 'SNA0001'", [crypto.createHash('sha256').update(SECRET).digest('hex')]);
  const before = (await q('SELECT count(*)::int n FROM school.device_logs'))[0].n;
  const att0 = (await q('SELECT count(*)::int n FROM school.attendance_logs'))[0].n;
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const t = `${today} 06:${String(10 + Math.floor(Math.random() * 40)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`;
  const r = await fetch(`${BASE}/iclock/cdata?SN=SNA0001&table=ATTLOG&token=A-device-secret-0123456789`, { method: 'POST', body: `101\t${t}\t0\t1\n` });
  const after = (await q('SELECT count(*)::int n FROM school.device_logs'))[0].n;
  const att1 = (await q('SELECT count(*)::int n FROM school.attendance_logs'))[0].n;
  console.log('punch', r.status, await r.text(), '| device_logs +' + (after - before), '| attendance +' + (att1 - att0));
}
await db.end();
