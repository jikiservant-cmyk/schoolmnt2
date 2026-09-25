import assert from 'node:assert/strict';
import test from 'node:test';
import { createAttendanceIdentity } from '../lib/attendance/idempotency.ts';

test('attendance identity is stable for retries on the same EAT day', () => {
  const first = createAttendanceIdentity(
    'school-a',
    'person-a',
    'check_in',
    '2026-09-25T03:05:00.000Z',
  );
  const retry = createAttendanceIdentity(
    'school-a',
    'person-a',
    'check_in',
    '2026-09-25T20:59:00.000Z',
  );

  assert.deepEqual(first, retry);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('attendance identity changes across school, person, type, and EAT day', () => {
  const original = createAttendanceIdentity('school-a', 'person-a', 'check_in', '2026-09-25T03:00:00Z');
  const differentKeys = [
    createAttendanceIdentity('school-b', 'person-a', 'check_in', '2026-09-25T03:00:00Z'),
    createAttendanceIdentity('school-a', 'person-b', 'check_in', '2026-09-25T03:00:00Z'),
    createAttendanceIdentity('school-a', 'person-a', 'check_out', '2026-09-25T03:00:00Z'),
    createAttendanceIdentity('school-a', 'person-a', 'check_in', '2026-09-26T03:00:00Z'),
  ];

  for (const identity of differentKeys) {
    assert.notEqual(identity.id, original.id);
    assert.notEqual(identity.idempotency_key, original.idempotency_key);
  }
});

test('attendance identity rejects invalid timestamps and missing tenant/person context', () => {
  assert.throws(() => createAttendanceIdentity('school-a', 'person-a', 'check_in', 'not-a-date'), TypeError);
  assert.throws(() => createAttendanceIdentity('', 'person-a', 'check_in', new Date()), TypeError);
});
