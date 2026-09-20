const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { YoutubeModerationAdapter } = source('packages/provider-adapters/src/youtube-moderation.ts');
const input = { accessToken: 'test-only-access', externalMessageId: 'message-1' };

test('deletion sends one authorized request without a body and accepts 204', async () => {
  let calls = 0;
  const adapter = new YoutubeModerationAdapter(async (url, init) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://www.googleapis.com');
    assert.equal(parsed.pathname, '/youtube/v3/liveChat/messages');
    assert.deepEqual([...parsed.searchParams], [['id', 'message & special/1']]);
    assert.equal(init.method, 'DELETE');
    assert.equal(init.headers.Authorization, 'Bearer test-only-access');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(
    await adapter.deleteMessage({ ...input, externalMessageId: 'message & special/1' }),
    {
      status: 'SUCCEEDED',
      http_status: 204,
    },
  );
  assert.equal(calls, 1);
});

test('invalid targets and tokens never reach the transport', async () => {
  const adapter = new YoutubeModerationAdapter(async () => {
    throw new Error('Transport must not run');
  });
  for (const invalid of [
    { ...input, externalMessageId: '' },
    { ...input, externalMessageId: ' ' },
    { ...input, externalMessageId: 'x'.repeat(1025) },
    { ...input, accessToken: '' },
    { ...input, accessToken: 'invalid\r\nheader' },
  ]) {
    assert.deepEqual(await adapter.deleteMessage(invalid), {
      status: 'NOT_SENT',
      code: 'INVALID_REQUEST',
    });
  }
});

test('cancellation before dispatch never reaches the transport', async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = new YoutubeModerationAdapter(async () => {
    throw new Error('Transport must not run');
  });
  assert.deepEqual(await adapter.deleteMessage({ ...input, signal: controller.signal }), {
    status: 'NOT_SENT',
    code: 'REQUEST_CANCELLED',
  });
});

for (const [status, code] of [
  [400, 'INVALID_REQUEST'],
  [401, 'RECONNECT_REQUIRED'],
  [403, 'YOUTUBE_FORBIDDEN'],
  [404, 'MESSAGE_NOT_FOUND'],
  [429, 'YOUTUBE_RATE_LIMITED'],
]) {
  test(`HTTP ${status} is a rejection, not successful deletion`, async () => {
    let calls = 0;
    const adapter = new YoutubeModerationAdapter(async () => {
      calls++;
      return new Response('private provider response', { status });
    });
    assert.deepEqual(await adapter.deleteMessage(input), {
      status: 'REJECTED',
      http_status: status,
      code,
    });
    assert.equal(calls, 1);
  });
}

test('network failure after dispatch stays unknown and is not retried', async () => {
  let calls = 0;
  const adapter = new YoutubeModerationAdapter(async () => {
    calls++;
    throw new Error('private transport details');
  });
  assert.deepEqual(await adapter.deleteMessage(input), {
    status: 'UNKNOWN',
    http_status: null,
    code: 'TRANSPORT_ERROR',
  });
  assert.equal(calls, 1);
});

test('cancellation after dispatch cannot claim the request was not sent', async () => {
  const controller = new AbortController();
  const adapter = new YoutubeModerationAdapter(async () => {
    controller.abort();
    throw new Error('Request aborted');
  });
  assert.deepEqual(await adapter.deleteMessage({ ...input, signal: controller.signal }), {
    status: 'UNKNOWN',
    http_status: null,
    code: 'REQUEST_INTERRUPTED',
  });
});

for (const status of [200, 202, 302, 408, 500, 503]) {
  test(`HTTP ${status} does not confirm deletion`, async () => {
    const adapter = new YoutubeModerationAdapter(async () => new Response(null, { status }));
    assert.deepEqual(await adapter.deleteMessage(input), {
      status: 'UNKNOWN',
      http_status: status,
      code: status >= 500 ? 'YOUTUBE_UNAVAILABLE' : 'UNEXPECTED_RESPONSE',
    });
  });
}

test('received 204 remains confirmation even if cancellation follows', async () => {
  const controller = new AbortController();
  const adapter = new YoutubeModerationAdapter(async () => {
    controller.abort();
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(await adapter.deleteMessage({ ...input, signal: controller.signal }), {
    status: 'SUCCEEDED',
    http_status: 204,
  });
});
