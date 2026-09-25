import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEligibleStudentIds,
  getNextKioskAttendanceType,
  validateAttendanceSelection,
} from '../lib/attendance/marking.ts';
import {
  createPunchTimestampIndex,
  findNearDuplicatePunch,
  isDeviceOwnedBySchool,
  isEventOwnedByDevice,
  isPersonInSchool,
  rememberPunch,
} from '../lib/devices/tenant-safety.ts';
import type { AttendanceEvent, DeviceRecord } from '../lib/devices/types.ts';
import { normalizeDeviceSerialNumber } from '../lib/devices/serial.ts';
import { getClientSafeDeviceMetadata, hashDeviceSecret, isAuthorizedToken } from '../lib/devices/metadata.ts';

const schoolA = 'school-a';
const schoolB = 'school-b';
const deviceA = {
  id: 'device-a',
  school_id: schoolA,
} as DeviceRecord;

function event(overrides: Partial<AttendanceEvent> = {}): AttendanceEvent {
  return {
    school_id: schoolA,
    device_id: 'device-a',
    raw_serial_number: 'A-TERMINAL',
    person_external_id: '101',
    timestamp: new Date('2026-09-25T06:00:00.000Z'),
    event_type: 'check_in',
    ...overrides,
  };
}

test('each biometric token must match that device\'s own stored digest', () => {
  const schoolASecret = 'dev_sec_school_a_test_only';
  const schoolBSecretHash = hashDeviceSecret('dev_sec_school_b_test_only');

  assert.equal(isAuthorizedToken(schoolASecret, hashDeviceSecret(schoolASecret)), true);
  assert.equal(isAuthorizedToken(schoolASecret, schoolBSecretHash), false);
  assert.equal(isAuthorizedToken(schoolASecret, null), false);
  assert.equal(isAuthorizedToken(null, hashDeviceSecret(schoolASecret)), false);
});

test('device secrets and packed credential metadata are never serialized to the client', () => {
  const safeDevice = getClientSafeDeviceMetadata({
    id: 'device-a',
    school_id: schoolA,
    serial_number: 'A-TERMINAL',
    firmware_version: 'Ver 2|META:{"secret":"legacy-secret"}',
    device_secret: 'legacy-secret',
    device_secret_hash: hashDeviceSecret('legacy-secret'),
  });

  assert.equal('device_secret' in safeDevice, false);
  assert.equal('device_secret_hash' in safeDevice, false);
  assert.equal(safeDevice.firmware_version, 'Ver 2');
});

test('device serial lookups reject wildcards and normalize exact serials', () => {
  assert.equal(normalizeDeviceSerialNumber(' a-100_2 '), 'A-100_2');
  assert.equal(normalizeDeviceSerialNumber('A%'), null);
  assert.equal(normalizeDeviceSerialNumber('A,B'), null);
  assert.equal(normalizeDeviceSerialNumber(''), null);
});

test('biometric event must carry the authenticated device and tenant identity', () => {
  assert.equal(isEventOwnedByDevice(event(), deviceA), true);
  assert.equal(isEventOwnedByDevice(event({ school_id: schoolB }), deviceA), false);
  assert.equal(isEventOwnedByDevice(event({ device_id: 'device-b' }), deviceA), false);
  assert.equal(isEventOwnedByDevice(event({ timestamp: new Date(Number.NaN) }), deviceA), false);
});

test('a device command target must belong to the requesting school', () => {
  assert.equal(isDeviceOwnedBySchool({ school_id: schoolA }, schoolA), true);
  assert.equal(isDeviceOwnedBySchool({ school_id: schoolB }, schoolA), false);
  assert.equal(isDeviceOwnedBySchool(null, schoolA), false);
});

test('a related person from another school is not accepted for credential matching', () => {
  assert.equal(isPersonInSchool({ id: 'person-a', school_id: schoolA, is_active: true }, schoolA), true);
  assert.equal(isPersonInSchool({ id: 'person-b', school_id: schoolB, is_active: true }, schoolA), false);
  assert.equal(isPersonInSchool({ id: 'inactive', school_id: schoolA, is_active: false }, schoolA), false);
});

test('device punch de-duplication catches repeats within two seconds, but not another type or later punch', () => {
  const first = {
    id: 'attendance-1',
    person_id: 'person-a',
    attendance_type: 'check_in',
    occurred_at: '2026-09-25T06:00:00.000Z',
  };
  const index = createPunchTimestampIndex([first]);

  assert.equal(findNearDuplicatePunch(index, 'person-a', '2026-09-25T06:00:01.500Z', 'check_in')?.id, 'attendance-1');
  assert.equal(findNearDuplicatePunch(index, 'person-a', '2026-09-25T06:00:01.500Z', 'check_out'), null);
  assert.equal(findNearDuplicatePunch(index, 'person-a', '2026-09-25T06:00:03.000Z', 'check_in'), null);

  rememberPunch(index, 'person-a', '2026-09-25T06:00:03.000Z', 'check_in', {
    id: 'attendance-2',
    person_id: 'person-a',
    attendance_type: 'check_in',
    occurred_at: '2026-09-25T06:00:03.000Z',
  });
  assert.equal(findNearDuplicatePunch(index, 'person-a', '2026-09-25T06:00:04.000Z', 'check_in')?.id, 'attendance-2');
});

test('kiosk route toggles check-in then check-out and blocks marks after both exist', () => {
  assert.equal(getNextKioskAttendanceType([]), 'check_in');
  assert.equal(getNextKioskAttendanceType([{ attendance_type: 'check_in' }]), 'check_out');
  assert.equal(getNextKioskAttendanceType([
    { attendance_type: 'check_in' },
    { attendance_type: 'check_out' },
  ]), null);
});

test('class attendance rejects cross-tenant, duplicate, and overlapping student IDs', () => {
  const allowed = new Set(['student-a1', 'student-a2']);

  assert.deepEqual(
    validateAttendanceSelection(['student-a1'], [], allowed),
    { ok: true, presentStudentIds: ['student-a1'], absentStudentIds: [] },
  );
  assert.equal(validateAttendanceSelection(['student-b1'], [], allowed).ok, false);
  assert.equal(validateAttendanceSelection(['student-a1', 'student-a1'], [], allowed).ok, false);
  assert.equal(validateAttendanceSelection(['student-a1'], ['student-a1'], allowed).ok, false);
});

test('manual attendance route skips students already marked for that attendance type', () => {
  const existing = [
    { person_id: 'student-a1', attendance_type: 'check_in' },
    { person_id: 'student-a2', attendance_type: 'check_out' },
  ];

  assert.deepEqual(
    getEligibleStudentIds(['student-a1', 'student-a2'], 'check_in', existing),
    ['student-a2'],
  );
});
