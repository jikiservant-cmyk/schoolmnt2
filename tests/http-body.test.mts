import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readRequestTextLimited,
  RequestBodyTooLargeError,
} from '../lib/http/read-limited-body.ts';

function requestWithBody(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/api', {
    method: 'POST',
    headers,
    body,
  });
}

test('limited request reader accepts bodies at or below the byte limit', async () => {
  assert.equal(await readRequestTextLimited(requestWithBody('hello'), 5), 'hello');
  assert.equal(await readRequestTextLimited(requestWithBody('é'), 2), 'é');
});

test('limited request reader rejects an oversized declared content length before reading', async () => {
  await assert.rejects(
    readRequestTextLimited(requestWithBody('hello', { 'content-length': '5' }), 4),
    RequestBodyTooLargeError,
  );
});

test('limited request reader enforces the stream limit when content length is absent', async () => {
  await assert.rejects(
    readRequestTextLimited(requestWithBody('hello'), 4),
    RequestBodyTooLargeError,
  );
});
