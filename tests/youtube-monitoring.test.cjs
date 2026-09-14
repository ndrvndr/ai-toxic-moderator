const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { GoogleProvider, GoogleProviderError } = source('apps/api/src/auth/google-provider.ts');

const broadcastId = 'test-live-1';
const channelId = 'test-channel-1';

function createProvider({
  exists = true,
  owned = true,
  status = 'live',
  liveChatId = 'test-chat-1',
  paginated = false,
  repeatingPage = false,
} = {}) {
  const calls = [];

  const provider = new GoogleProvider(async (url, init) => {
    const parsed = new URL(url);
    calls.push(parsed);

    assert.equal(init.headers.Authorization, 'Bearer test-access-token');
    assert.equal(init.redirect, 'error');

    if (parsed.pathname.endsWith('/liveBroadcasts')) {
      assert.equal(parsed.searchParams.get('id'), broadcastId);
      assert.equal(parsed.searchParams.has('mine'), false);
      assert.equal(parsed.searchParams.has('broadcastStatus'), false);

      return Response.json({
        items: exists
          ? [
              {
                id: broadcastId,
                snippet: {
                  channelId,
                  title: 'Test live broadcast',
                  liveChatId,
                },
                status: { lifeCycleStatus: status },
              },
            ]
          : [],
      });
    }

    assert.equal(parsed.pathname, '/youtube/v3/channels');
    assert.equal(parsed.searchParams.get('mine'), 'true');

    if (repeatingPage) {
      return Response.json({
        items: [],
        nextPageToken: 'repeated-page',
      });
    }

    if (paginated && !parsed.searchParams.has('pageToken')) {
      return Response.json({
        items: [],
        nextPageToken: 'page-2',
      });
    }

    return Response.json({
      items: [
        {
          id: owned ? channelId : 'another-channel',
          snippet: { title: 'Test channel' },
        },
      ],
    });
  });

  return { provider, calls };
}

function hasCode(code) {
  return (error) => error instanceof GoogleProviderError && error.code === code;
}

test('verifies an owned live broadcast with available chat', async () => {
  const { provider, calls } = createProvider();

  const result = await provider.verifyBroadcast('test-access-token', broadcastId);

  assert.deepEqual(result, {
    youtube_broadcast_id: broadcastId,
    youtube_channel_id: channelId,
    channel_title: 'Test channel',
    title: 'Test live broadcast',
    live_chat_id: 'test-chat-1',
  });

  assert.equal(calls.length, 2);
  assert.equal(Object.isFrozen(result), true);
});

test('rejects invalid IDs before making provider requests', async () => {
  const { provider, calls } = createProvider();

  await assert.rejects(
    provider.verifyBroadcast('test-access-token', 'first,second'),
    hasCode('INVALID_BROADCAST_ID'),
  );

  assert.equal(calls.length, 0);
});

test('rejects missing broadcasts', async () => {
  const { provider } = createProvider({ exists: false });

  await assert.rejects(
    provider.verifyBroadcast('test-access-token', broadcastId),
    hasCode('BROADCAST_NOT_FOUND'),
  );
});

test('rejects broadcasts belonging to another channel', async () => {
  const { provider } = createProvider({ owned: false });

  await assert.rejects(
    provider.verifyBroadcast('test-access-token', broadcastId),
    hasCode('BROADCAST_NOT_OWNED'),
  );
});

test('rejects broadcasts that are not live', async () => {
  const { provider } = createProvider({ status: 'complete' });

  await assert.rejects(
    provider.verifyBroadcast('test-access-token', broadcastId),
    hasCode('BROADCAST_NOT_LIVE'),
  );
});

test('rejects broadcasts without live chat', async () => {
  const { provider } = createProvider({ liveChatId: '' });

  await assert.rejects(
    provider.verifyBroadcast('test-access-token', broadcastId),
    hasCode('LIVE_CHAT_UNAVAILABLE'),
  );
});

test('checks subsequent pages when verifying channel ownership', async () => {
  const { provider, calls } = createProvider({ paginated: true });

  await provider.verifyBroadcast('test-access-token', broadcastId);

  assert.equal(calls.length, 3);
  assert.equal(calls[2].searchParams.get('pageToken'), 'page-2');
});

test('rejects repeated pagination tokens instead of assuming ownership', async () => {
  const { provider } = createProvider({ repeatingPage: true });

  await assert.rejects(
    provider.verifyBroadcast('test-access-token', broadcastId),
    hasCode('YOUTUBE_LOOKUP_INCOMPLETE'),
  );
});
