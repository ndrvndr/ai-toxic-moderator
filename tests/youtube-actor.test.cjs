const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { YoutubeActorAdapter } = source('packages/provider-adapters/src/youtube-actor.ts');

const channelId = `UC${'a'.repeat(22)}`;
const otherChannelId = `UC${'b'.repeat(22)}`;

function body() {
  return {
    kind: 'youtube#channelListResponse',
    items: [{ id: channelId }],
    pageInfo: { totalResults: 1 },
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('resolves one channel using the supplied credential', async () => {
  let calls = 0;

  const adapter = new YoutubeActorAdapter(async (input, options) => {
    calls += 1;

    const url = new URL(input);

    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.pathname, '/youtube/v3/channels');
    assert.equal(url.searchParams.get('part'), 'id');
    assert.equal(url.searchParams.get('mine'), 'true');
    assert.equal(url.searchParams.get('maxResults'), '2');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);

    return json(body());
  });

  assert.deepEqual(await adapter.resolve('test-token'), {
    status: 'RESOLVED',
    channelId,
  });
  assert.equal(calls, 1);
});

test('does not choose a channel from an ambiguous or incomplete list', async () => {
  const inputs = [
    { ...body(), items: [], pageInfo: { totalResults: 0 } },
    {
      ...body(),
      items: [{ id: channelId }, { id: otherChannelId }],
      pageInfo: { totalResults: 2 },
    },
    { ...body(), nextPageToken: 'next-page' },
    { ...body(), pageInfo: { totalResults: 2 } },
  ];

  for (const input of inputs) {
    const adapter = new YoutubeActorAdapter(async () => json(input));

    assert.deepEqual(await adapter.resolve('test-token'), {
      status: 'UNRESOLVED',
      code: 'AMBIGUOUS_IDENTITY',
      httpStatus: 200,
    });
  }
});

test('rejects malformed channel responses', async () => {
  const inputs = [
    null,
    {},
    { ...body(), kind: 'unexpected' },
    { ...body(), items: [{ id: 'invalid-channel' }] },
    { ...body(), items: [{ id: null }] },
    { ...body(), pageInfo: { totalResults: '1' } },
  ];

  for (const input of inputs) {
    const adapter = new YoutubeActorAdapter(async () => json(input));
    const result = await adapter.resolve('test-token');

    assert.equal(result.status, 'UNRESOLVED');
    assert.equal(result.code, 'INVALID_RESPONSE');
  }
});

test('rejects invalid JSON', async () => {
  const adapter = new YoutubeActorAdapter(async () => new Response('not-json', { status: 200 }));

  assert.deepEqual(await adapter.resolve('test-token'), {
    status: 'UNRESOLVED',
    code: 'INVALID_RESPONSE',
    httpStatus: 200,
  });
});

test('returns safe HTTP failures without retries or response contents', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;

    const adapter = new YoutubeActorAdapter(async () => {
      calls += 1;
      return json({ privateDetail: 'do-not-expose' }, status);
    });

    assert.deepEqual(await adapter.resolve('test-token'), {
      status: 'UNRESOLVED',
      code: 'HTTP_ERROR',
      httpStatus: status,
    });
    assert.equal(calls, 1);
  }
});

test('does not send invalid tokens or already cancelled requests', async () => {
  let calls = 0;

  const adapter = new YoutubeActorAdapter(async () => {
    calls += 1;
    return json(body());
  });

  for (const token of ['', ' ', 'token\nvalue']) {
    const result = await adapter.resolve(token);
    assert.equal(result.code, 'INVALID_TOKEN');
  }

  const controller = new AbortController();
  controller.abort();

  assert.deepEqual(await adapter.resolve('test-token', controller.signal), {
    status: 'UNRESOLVED',
    code: 'REQUEST_CANCELLED',
    httpStatus: null,
  });
  assert.equal(calls, 0);
});

test('transport failures do not expose credentials or exception details', async () => {
  let calls = 0;

  const adapter = new YoutubeActorAdapter(async () => {
    calls += 1;
    throw new Error('private token and transport details');
  });

  assert.deepEqual(await adapter.resolve('test-token'), {
    status: 'UNRESOLVED',
    code: 'TRANSPORT_ERROR',
    httpStatus: null,
  });
  assert.equal(calls, 1);
});

test('cancellation during a request cannot resolve an identity', async () => {
  const controller = new AbortController();

  const adapter = new YoutubeActorAdapter(async () => {
    controller.abort();
    return json(body());
  });

  const result = await adapter.resolve('test-token', controller.signal);

  assert.equal(result.status, 'UNRESOLVED');
  assert.equal(result.code, 'REQUEST_CANCELLED');
});
