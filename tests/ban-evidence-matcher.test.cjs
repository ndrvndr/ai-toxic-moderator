const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { matchBanEvidence } = source('apps/worker/src/ingestion/ban-evidence-matcher.ts');

const attempt = {
  status: 'UNKNOWN',
  action: 'TIMEOUT',
  liveChatId: 'chat-1',
  targetChannelId: 'viewer-1',
  moderatorChannelId: 'moderator-1',
  durationSeconds: '30',
  startedAt: '2026-09-23T10:00:00Z',
  deadlineAt: '2026-09-23T10:00:30Z',
};

const evidence = {
  externalEventId: 'event-1',
  liveChatId: 'chat-1',
  targetChannelId: 'viewer-1',
  moderatorChannelId: 'moderator-1',
  action: 'TIMEOUT',
  durationSeconds: '30',
  publishedAt: '2026-09-23T10:00:05Z',
};

test('matching evidence remains unattributed to the application attempt', () => {
  assert.deepEqual(matchBanEvidence(attempt, evidence), {
    matched: true,
    attribution: 'UNPROVEN',
  });
});

test('permanent ban evidence can match without a duration', () => {
  assert.deepEqual(
    matchBanEvidence(
      { ...attempt, action: 'BAN', durationSeconds: null },
      { ...evidence, action: 'BAN', durationSeconds: null },
    ),
    { matched: true, attribution: 'UNPROVEN' },
  );
});

test('scope, actor, action, and duration mismatches are rejected', () => {
  for (const [change, reason] of [
    [{ liveChatId: 'other-chat' }, 'LIVE_CHAT_MISMATCH'],
    [{ targetChannelId: 'other-viewer' }, 'TARGET_MISMATCH'],
    [{ moderatorChannelId: 'other-moderator' }, 'MODERATOR_MISMATCH'],
    [{ action: 'BAN', durationSeconds: null }, 'ACTION_MISMATCH'],
    [{ durationSeconds: '60' }, 'DURATION_MISMATCH'],
  ]) {
    assert.deepEqual(matchBanEvidence(attempt, { ...evidence, ...change }), {
      matched: false,
      reason,
    });
  }
});

test('events outside the attempt window are not selected', () => {
  for (const publishedAt of ['2026-09-23T09:59:59Z', '2026-09-23T10:00:31Z', 'invalid']) {
    assert.deepEqual(matchBanEvidence(attempt, { ...evidence, publishedAt }), {
      matched: false,
      reason: 'OUTSIDE_ATTEMPT_WINDOW',
    });
  }
});

test('window boundaries are inclusive', () => {
  for (const publishedAt of [attempt.startedAt, attempt.deadlineAt]) {
    assert.equal(matchBanEvidence(attempt, { ...evidence, publishedAt }).matched, true);
  }
});

test('invalid attempt metadata cannot select evidence', () => {
  for (const change of [
    { status: 'SUCCEEDED' },
    { startedAt: 'invalid' },
    { deadlineAt: attempt.startedAt },
    { moderatorChannelId: '' },
    { durationSeconds: null },
    { durationSeconds: '0' },
    { action: 'BAN', durationSeconds: '30' },
  ]) {
    assert.deepEqual(matchBanEvidence({ ...attempt, ...change }, evidence), {
      matched: false,
      reason: 'INVALID_ATTEMPT',
    });
  }
});

test('matching does not mutate the attempt or evidence', () => {
  const frozenAttempt = Object.freeze({ ...attempt });
  const frozenEvidence = Object.freeze({ ...evidence });

  assert.equal(matchBanEvidence(frozenAttempt, frozenEvidence).matched, true);
  assert.equal(frozenAttempt.status, 'UNKNOWN');
});
