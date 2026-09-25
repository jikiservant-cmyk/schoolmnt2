import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asJsonObject,
  firstScalarString,
  isJsonObject,
  parseNajikiWebhookPayload,
} from '../lib/payments/najiki-payload.ts';

test('Najiki webhook parser accepts only JSON objects', () => {
  assert.deepEqual(parseNajikiWebhookPayload('{"event":"payment.success"}'), { event: 'payment.success' });
  for (const invalid of ['null', '[]', 'false', '123', '"text"', '{bad json']) {
    assert.equal(parseNajikiWebhookPayload(invalid), null);
  }
  assert.equal(isJsonObject(null), false);
  assert.equal(asJsonObject([]), null);
});

test('webhook scalar extraction never coerces objects or accepts control characters as structure', () => {
  assert.equal(firstScalarString({ toString: null }, null, ' school-42 '), 'school-42');
  assert.equal(firstScalarString({ value: 'school-42' }, true), '');
  assert.equal(firstScalarString(123), '123');
});
