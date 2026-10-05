const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { YoutubeUnbanAdapter } = source('packages/provider-adapters/src/youtube-unban.ts');
const input = { accessToken: 'fixture-token', banId: 'ban&other=value/#' };

test('unban sends one DELETE with an encoded ID and accepts only 204', async () => {
  const calls = [];
  const adapter = new YoutubeUnbanAdapter(async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(await adapter.removeBan(input), { status: 'SUCCEEDED', http_status: 204 });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://www.googleapis.com');
  assert.equal(parsed.pathname, '/youtube/v3/liveChat/bans');
  assert.deepEqual([...parsed.searchParams], [['id', input.banId]]);
  assert.equal(init.method, 'DELETE');
  assert.equal(init.body, undefined);
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer fixture-token');
  assert.equal(url.includes(input.accessToken), false);
  assert.equal(init.signal.aborted, false);
});

test('invalid input and cancellation before dispatch never send', async () => {
  let calls = 0;
  const adapter = new YoutubeUnbanAdapter(async () => {
    calls++;
    throw Error('Unexpected');
  });
  for (const invalid of [
    { ...input, banId: '' },
    { ...input, banId: ' ' },
    { ...input, banId: 'x'.repeat(1025) },
    { ...input, accessToken: 'bad\r\nheader' },
    { ...input, accessToken: '' },
    { ...input, liveChatId: 'untrusted' },
  ])
    assert.deepEqual(await adapter.removeBan(invalid), {
      status: 'NOT_SENT',
      code: 'INVALID_REQUEST',
    });
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await adapter.removeBan({ ...input, signal: abort.signal }), {
    status: 'NOT_SENT',
    code: 'REQUEST_CANCELLED',
  });
  assert.equal(calls, 0);
});

for (const [status, code] of [
  [400, 'INVALID_REQUEST'],
  [401, 'RECONNECT_REQUIRED'],
  [403, 'YOUTUBE_FORBIDDEN'],
  [404, 'BAN_NOT_FOUND'],
  [429, 'YOUTUBE_RATE_LIMITED'],
])
  test(`HTTP ${status} is rejected once with no provider error disclosure`, async () => {
    let calls = 0;
    const adapter = new YoutubeUnbanAdapter(async () => {
      calls++;
      return new Response('private provider details fixture-token', { status });
    });
    assert.deepEqual(await adapter.removeBan(input), {
      status: 'REJECTED',
      http_status: status,
      code,
    });
    assert.equal(calls, 1);
  });

for (const status of [200, 201, 302, 500, 503])
  test(`HTTP ${status} cannot confirm unban or trigger retry`, async () => {
    let calls = 0;
    const adapter = new YoutubeUnbanAdapter(async () => {
      calls++;
      return new Response('private response', { status });
    });
    assert.deepEqual(await adapter.removeBan(input), {
      status: 'UNKNOWN',
      http_status: status,
      code: status >= 500 ? 'YOUTUBE_UNAVAILABLE' : 'UNEXPECTED_RESPONSE',
    });
    assert.equal(calls, 1);
  });

test('lost responses and interruption after dispatch remain unknown', async () => {
  let calls = 0;
  const abort = new AbortController();
  const adapter = new YoutubeUnbanAdapter(async (_, init) => {
    calls++;
    if (calls === 2) {
      abort.abort();
      assert.equal(init.signal.aborted, true);
    }
    throw Error('private transport details fixture-token');
  });
  assert.deepEqual(await adapter.removeBan(input), {
    status: 'UNKNOWN',
    http_status: null,
    code: 'TRANSPORT_ERROR',
  });
  assert.deepEqual(await adapter.removeBan({ ...input, signal: abort.signal }), {
    status: 'UNKNOWN',
    http_status: null,
    code: 'REQUEST_INTERRUPTED',
  });
  assert.equal(calls, 2);
});
