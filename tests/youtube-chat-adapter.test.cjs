const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { YoutubeChatAdapter, YoutubeChatError } = source(
  'packages/provider-adapters/src/youtube-chat.ts',
);

const input = {
  accessToken: 'test-access-token',
  liveChatId: 'test-live-chat',
  pageToken: null,
};

function resource(id = 'message-1') {
  return {
    id,
    snippet: {
      type: 'textMessageEvent',
      liveChatId: input.liveChatId,
      publishedAt: '2026-01-01T00:00:00Z',
      textMessageDetails: { messageText: 'Test message' },
    },
  };
}

function page(overrides = {}) {
  return {
    nextPageToken: 'next-page',
    pollingIntervalMillis: 5000,
    items: [resource()],
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => error instanceof YoutubeChatError && error.code === code;
}

test('initial request sends authorization in a header and omits pageToken', async () => {
  const adapter = new YoutubeChatAdapter(async (url, init) => {
    const parsed = new URL(url);

    assert.equal(parsed.origin, 'https://www.googleapis.com');
    assert.equal(parsed.pathname, '/youtube/v3/liveChat/messages');
    assert.equal(parsed.searchParams.get('liveChatId'), input.liveChatId);
    assert.equal(parsed.searchParams.get('part'), 'id,snippet,authorDetails');
    assert.equal(parsed.searchParams.get('maxResults'), '500');
    assert.equal(parsed.searchParams.has('pageToken'), false);
    assert.equal(parsed.searchParams.has('access_token'), false);
    assert.equal(init.headers.Authorization, `Bearer ${input.accessToken}`);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);

    return Response.json(page());
  });

  const result = await adapter.list(input);

  assert.equal(result.next_page_token, 'next-page');
  assert.equal(result.polling_interval_ms, 5000);
  assert.equal(result.offline_at, null);
  assert.equal(result.items.length, 1);
  assert.equal(JSON.stringify(result).includes(input.accessToken), false);
});

test('continuation token is transmitted without modification', async () => {
  const token = 'opaque+/token=with&symbols';

  const adapter = new YoutubeChatAdapter(async (url) => {
    assert.equal(new URL(url).searchParams.get('pageToken'), token);
    return Response.json(page({ items: [] }));
  });

  assert.equal((await adapter.list({ ...input, pageToken: token })).items.length, 0);
});

test('malformed and cross-chat responses are rejected', async () => {
  const wrongChat = resource();
  wrongChat.snippet.liveChatId = 'another-chat';

  for (const body of [
    {},
    page({ nextPageToken: undefined }),
    page({ pollingIntervalMillis: -1 }),
    page({ items: [wrongChat] }),
  ]) {
    const adapter = new YoutubeChatAdapter(async () => Response.json(body));

    await assert.rejects(adapter.list(input), expectCode('INVALID_PROVIDER_RESPONSE'));
  }

  const invalidJson = new YoutubeChatAdapter(async () => new Response('not-json', { status: 200 }));

  await assert.rejects(invalidJson.list(input), expectCode('INVALID_PROVIDER_RESPONSE'));
});

test('offline metadata and active poll resources are preserved', async () => {
  const poll = {
    ...resource('poll-1'),
    snippet: {
      ...resource().snippet,
      type: 'pollEvent',
    },
  };

  const adapter = new YoutubeChatAdapter(async () =>
    Response.json(
      page({
        nextPageToken: undefined,
        offlineAt: '2026-01-01T00:01:00Z',
        activePollItem: poll,
      }),
    ),
  );

  const result = await adapter.list(input);

  assert.equal(result.next_page_token, null);
  assert.equal(result.offline_at, '2026-01-01T00:01:00Z');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].id, 'poll-1');
});

test('provider errors are classified without exposing response details', async () => {
  const cases = [
    [401, 'authError', 'RECONNECT_REQUIRED'],
    [403, 'liveChatEnded', 'LIVE_CHAT_ENDED'],
    [403, 'liveChatDisabled', 'LIVE_CHAT_DISABLED'],
    [404, 'liveChatNotFound', 'LIVE_CHAT_NOT_FOUND'],
    [403, 'quotaExceeded', 'YOUTUBE_QUOTA_EXCEEDED'],
    [403, 'rateLimitExceeded', 'YOUTUBE_RATE_LIMITED'],
    [429, 'unknown', 'YOUTUBE_RATE_LIMITED'],
    [403, 'forbidden', 'YOUTUBE_FORBIDDEN'],
    [400, 'invalidPageToken', 'INVALID_PAGE_TOKEN'],
    [503, 'backendError', 'YOUTUBE_UNAVAILABLE'],
  ];

  for (const [status, reason, code] of cases) {
    let calls = 0;

    const adapter = new YoutubeChatAdapter(async () => {
      calls++;

      return Response.json(
        {
          error: {
            message: 'sensitive-provider-detail',
            errors: [{ reason }],
          },
        },
        { status, headers: { 'Retry-After': '12' } },
      );
    });

    await assert.rejects(adapter.list(input), (error) => {
      assert.equal(expectCode(code)(error), true);
      assert.equal(error.message.includes('sensitive-provider-detail'), false);

      if (code === 'YOUTUBE_RATE_LIMITED' || code === 'YOUTUBE_UNAVAILABLE') {
        assert.equal(error.retryAfterMs, 12000);
      }

      return true;
    });

    assert.equal(calls, 1);
  }
});

test('transport errors are sanitized', async () => {
  const adapter = new YoutubeChatAdapter(async () => {
    throw new Error('sensitive-network-detail');
  });

  await assert.rejects(adapter.list(input), (error) => {
    assert.equal(expectCode('YOUTUBE_UNAVAILABLE')(error), true);
    assert.equal(error.message.includes('sensitive-network-detail'), false);
    return true;
  });
});

test('already cancelled requests never call the transport', async () => {
  const controller = new AbortController();
  controller.abort();

  const adapter = new YoutubeChatAdapter(async () => {
    assert.fail('The transport must not be called');
  });

  await assert.rejects(
    adapter.list({ ...input, signal: controller.signal }),
    expectCode('REQUEST_CANCELLED'),
  );
});
