const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { parseYoutubeBanEvent } = source('packages/provider-adapters/src/youtube-ban-event.ts');

function event() {
  return {
    id: 'event-1',
    snippet: {
      type: 'userBannedEvent',
      liveChatId: 'chat-1',
      authorChannelId: 'moderator-1',
      publishedAt: '2026-09-23T10:00:00.123456Z',
      userBannedDetails: {
        banType: 'temporary',
        banDurationSeconds: '30',
        bannedUserDetails: {
          channelId: 'viewer-1',
          displayName: 'Private viewer name',
        },
      },
    },
    authorDetails: {
      channelId: 'moderator-1',
      displayName: 'Private moderator name',
    },
  };
}

test('temporary evidence distinguishes the moderator from the target', () => {
  assert.deepEqual(parseYoutubeBanEvent(event()), {
    externalEventId: 'event-1',
    liveChatId: 'chat-1',
    moderatorChannelId: 'moderator-1',
    targetChannelId: 'viewer-1',
    publishedAt: '2026-09-23T10:00:00.123456Z',
    action: 'TIMEOUT',
    durationSeconds: '30',
  });
});

test('numeric and decimal-string durations produce the same evidence', () => {
  for (const value of [30, '30']) {
    const input = event();
    input.snippet.userBannedDetails.banDurationSeconds = value;

    assert.equal(parseYoutubeBanEvent(input).durationSeconds, '30');
  }
});

test('permanent evidence does not invent a timeout duration', () => {
  const input = event();
  input.snippet.userBannedDetails.banType = 'permanent';
  delete input.snippet.userBannedDetails.banDurationSeconds;

  const result = parseYoutubeBanEvent(input);

  assert.equal(result.action, 'BAN');
  assert.equal(result.durationSeconds, null);
});

test('incomplete temporary evidence is rejected', () => {
  for (const value of [
    undefined,
    null,
    '',
    ' ',
    0,
    -1,
    1.5,
    true,
    '30seconds',
    '3e1',
    '9007199254740992',
  ]) {
    const input = event();
    input.snippet.userBannedDetails.banDurationSeconds = value;

    assert.equal(parseYoutubeBanEvent(input), null);
  }
});

test('missing scope, actor, target, or event identity is rejected', () => {
  const mutations = [
    (input) => delete input.id,
    (input) => delete input.snippet.liveChatId,
    (input) => delete input.snippet.authorChannelId,
    (input) => delete input.snippet.userBannedDetails.bannedUserDetails.channelId,
    (input) => {
      input.snippet.publishedAt = 'not-a-date';
    },
    (input) => {
      input.snippet.userBannedDetails.banType = 'unknown';
    },
  ];

  for (const mutate of mutations) {
    const input = event();
    mutate(input);
    assert.equal(parseYoutubeBanEvent(input), null);
  }
});

test('unrelated and malformed payloads are not moderation evidence', () => {
  const unrelated = event();
  unrelated.snippet.type = 'textMessageEvent';

  for (const input of [null, {}, [], 'invalid', unrelated]) {
    assert.equal(parseYoutubeBanEvent(input), null);
  }
});

test('evidence excludes raw payloads and does not claim attempt attribution', () => {
  const input = event();
  input.privateMetadata = 'private-extra-value';

  const result = parseYoutubeBanEvent(input);
  assert.ok(result);

  assert.equal('attemptId' in result, false);
  assert.equal('status' in result, false);
  assert.equal('payload' in result, false);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('Private viewer name'), false);
  assert.equal(serialized.includes('Private moderator name'), false);
  assert.equal(serialized.includes('private-extra-value'), false);
});
