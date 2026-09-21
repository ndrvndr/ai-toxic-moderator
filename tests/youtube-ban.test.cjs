const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { YoutubeBanAdapter } = source('packages/provider-adapters/src/youtube-ban.ts');
const base = { accessToken: 'test-only-token', liveChatId: 'chat-1', authorChannelId: 'viewer-1' };
const ban = { ...base, action: 'BAN' };
const timeout = { ...base, action: 'TIMEOUT', durationSeconds: 300 };
function resource(input) {
  return {
    kind: 'youtube#liveChatBan',
    id: 'ban-id',
    snippet: {
      liveChatId: input.liveChatId,
      type: input.action === 'TIMEOUT' ? 'temporary' : 'permanent',
      bannedUserDetails: { channelId: input.authorChannelId },
      ...(input.action === 'TIMEOUT' ? { banDurationSeconds: input.durationSeconds } : {}),
    },
  };
}

for (const input of [ban, timeout]) {
  test(`${input.action} sends the scoped request once and validates confirmation`, async () => {
    const calls = [];
    const adapter = new YoutubeBanAdapter(async (url, init) => {
      calls.push({ url, init });
      return Response.json(resource(input));
    });
    assert.deepEqual(await adapter.banUser(input), {
      status: 'SUCCEEDED',
      http_status: 200,
      ban_id: 'ban-id',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://www.googleapis.com/youtube/v3/liveChat/bans?part=snippet');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-only-token');
    assert.deepEqual(JSON.parse(calls[0].init.body), { snippet: resource(input).snippet });
  });
}

test('invalid durations, actions, targets, and tokens never dispatch', async () => {
  let calls = 0;
  const adapter = new YoutubeBanAdapter(async () => {
    calls++;
    throw Error('Unexpected');
  });
  for (const input of [
    { ...timeout, durationSeconds: 0 },
    { ...timeout, durationSeconds: -1 },
    { ...timeout, durationSeconds: 1.5 },
    { ...timeout, durationSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, action: 'TIMEOUT' },
    { ...ban, durationSeconds: 300 },
    { ...ban, action: 'DELETE' },
    { ...ban, accessToken: 'bad\r\nheader' },
    { ...ban, liveChatId: '' },
    { ...ban, authorChannelId: ' ' },
  ])
    assert.deepEqual(await adapter.banUser(input), { status: 'NOT_SENT', code: 'INVALID_REQUEST' });
  assert.equal(calls, 0);
});

test('cancellation before dispatch differs from interruption after dispatch', async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  const after = new AbortController();
  const adapter = new YoutubeBanAdapter(async () => {
    calls++;
    after.abort();
    throw Error('Private detail');
  });
  assert.deepEqual(await adapter.banUser({ ...ban, signal: before.signal }), {
    status: 'NOT_SENT',
    code: 'REQUEST_CANCELLED',
  });
  assert.deepEqual(await adapter.banUser({ ...ban, signal: after.signal }), {
    status: 'UNKNOWN',
    http_status: null,
    code: 'REQUEST_INTERRUPTED',
  });
  assert.equal(calls, 1);
});

for (const [status, code] of [
  [400, 'INVALID_REQUEST'],
  [401, 'RECONNECT_REQUIRED'],
  [403, 'YOUTUBE_FORBIDDEN'],
  [404, 'CHAT_OR_USER_NOT_FOUND'],
  [429, 'YOUTUBE_RATE_LIMITED'],
]) {
  test(`HTTP ${status} is rejected without leaking provider details or retrying`, async () => {
    let calls = 0;
    const adapter = new YoutubeBanAdapter(async () => {
      calls++;
      return new Response('private details', { status });
    });
    assert.deepEqual(await adapter.banUser(ban), { status: 'REJECTED', http_status: status, code });
    assert.equal(calls, 1);
  });
}

test('missing, malformed, or mismatched confirmation stays UNKNOWN', async () => {
  const good = resource(timeout);
  for (const body of [
    null,
    {},
    { ...good, id: '' },
    { ...good, kind: 'other' },
    { ...good, snippet: { ...good.snippet, liveChatId: 'other' } },
    { ...good, snippet: { ...good.snippet, type: 'permanent' } },
    { ...good, snippet: { ...good.snippet, banDurationSeconds: 30 } },
    { ...good, snippet: { ...good.snippet, bannedUserDetails: { channelId: 'other' } } },
  ]) {
    const adapter = new YoutubeBanAdapter(async () => Response.json(body));
    assert.deepEqual(await adapter.banUser(timeout), {
      status: 'UNKNOWN',
      http_status: 200,
      code: 'UNEXPECTED_RESPONSE',
    });
  }
  const adapter = new YoutubeBanAdapter(async () => new Response('not JSON', { status: 200 }));
  assert.equal((await adapter.banUser(ban)).status, 'UNKNOWN');
});

test('network and server failures do not retry or claim success', async () => {
  let calls = 0;
  const broken = new YoutubeBanAdapter(async () => {
    calls++;
    throw Error('private detail');
  });
  assert.deepEqual(await broken.banUser(ban), {
    status: 'UNKNOWN',
    http_status: null,
    code: 'TRANSPORT_ERROR',
  });
  assert.equal(calls, 1);
  for (const status of [204, 302, 408, 500, 503]) {
    const adapter = new YoutubeBanAdapter(async () => new Response(null, { status }));
    assert.deepEqual(await adapter.banUser(ban), {
      status: 'UNKNOWN',
      http_status: status,
      code: status >= 500 ? 'YOUTUBE_UNAVAILABLE' : 'UNEXPECTED_RESPONSE',
    });
  }
});

test('HTTP 201 requires the same validated resource as HTTP 200', async () => {
  const adapter = new YoutubeBanAdapter(async () => Response.json(resource(ban), { status: 201 }));
  assert.deepEqual(await adapter.banUser(ban), {
    status: 'SUCCEEDED',
    http_status: 201,
    ban_id: 'ban-id',
  });
});

test('a failed response body read cannot be reported as confirmed success', async () => {
  const adapter = new YoutubeBanAdapter(async () => ({
    status: 200,
    async json() {
      throw Error('private body failure');
    },
  }));
  assert.deepEqual(await adapter.banUser(ban), {
    status: 'UNKNOWN',
    http_status: 200,
    code: 'UNEXPECTED_RESPONSE',
  });
});
