import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAttendanceSessionToken,
  verifyAttendanceSessionToken,
} from '../lib/attendance/kiosk-session.ts';

process.env.ATTENDANCE_SESSION_SECRET = 'local-test-attendance-signing-secret';

const scope = {
  userId: 'auth-user-a',
  schoolId: 'school-a',
  classId: 'class-a',
  teacherId: 'teacher-a',
};
const fixedNow = 1_800_000_000_000;

test('attendance sessions are signed, scoped, and usable until expiry', () => {
  const token = createAttendanceSessionToken(scope, fixedNow);
  assert.deepEqual(verifyAttendanceSessionToken(token, scope, fixedNow + 60_000), scope);
  assert.equal(verifyAttendanceSessionToken(token, scope, fixedNow + 15 * 60 * 1000), null);
});

test('attendance sessions cannot be reused for a different user, school, class, or teacher', () => {
  const token = createAttendanceSessionToken(scope, fixedNow);
  for (const changed of [
    { ...scope, userId: 'auth-user-b' },
    { ...scope, schoolId: 'school-b' },
    { ...scope, classId: 'class-b' },
    { ...scope, teacherId: 'teacher-b' },
  ]) {
    assert.equal(verifyAttendanceSessionToken(token, changed, fixedNow), null);
  }
});

test('attendance session signatures reject tampering and malformed token input', () => {
  const token = createAttendanceSessionToken(scope, fixedNow);
  const [payload] = token.split('.');
  assert.equal(verifyAttendanceSessionToken(`${payload}.${'A'.repeat(43)}`, scope, fixedNow), null);
  assert.equal(verifyAttendanceSessionToken(null, scope, fixedNow), null);
  assert.equal(verifyAttendanceSessionToken('not-a-token', scope, fixedNow), null);
});
