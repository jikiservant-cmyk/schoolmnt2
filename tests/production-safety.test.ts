import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDeviceAuthTarget,
  hashDeviceSecret,
  isAuthorizedToken,
} from '../lib/devices/metadata';
import {
  exceedsBodyLimit,
  exceedsContentLength,
  MAX_DEVICE_BODY_BYTES,
} from '../lib/request-limits';

test('device authentication accepts the stored hash and rejects the wrong token', () => {
  const secret = 'dev_sec_test_only_1234567890';
  const device = {
    device_secret: null,
    device_secret_hash: hashDeviceSecret(secret),
  };

  const authTarget = getDeviceAuthTarget(device);
  assert.equal(isAuthorizedToken(secret, authTarget, undefined), true);
  assert.equal(isAuthorizedToken('wrong-token', authTarget, undefined), false);
});

test('device authentication does not fall back to an empty secret', () => {
  assert.equal(isAuthorizedToken('', null, undefined), false);
  assert.equal(isAuthorizedToken('anything', null, undefined), false);
});

test('request body limits reject oversized payloads', () => {
  assert.equal(exceedsBodyLimit('small payload', MAX_DEVICE_BODY_BYTES), false);
  assert.equal(exceedsBodyLimit('x'.repeat(MAX_DEVICE_BODY_BYTES + 1), MAX_DEVICE_BODY_BYTES), true);

  const request = new Request('https://example.test', {
    method: 'POST',
    headers: { 'content-length': String(MAX_DEVICE_BODY_BYTES + 1) },
  });
  assert.equal(exceedsContentLength(request, MAX_DEVICE_BODY_BYTES), true);
});
