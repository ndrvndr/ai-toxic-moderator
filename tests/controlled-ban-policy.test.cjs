const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const {
  controlledBanPolicy,
  controlledBanVersion,
  CONTROLLED_TIMEOUT_MESSAGE,
  CONTROLLED_BAN_MESSAGE,
  CONTROLLED_TIMEOUT_SECONDS,
} = source('apps/worker/src/ingestion/controlled-ban-policy.ts');

const scope = {
  sessionId: '10000000-0000-4000-8000-000000000001',
  authorChannelId: 'UC' + 'a'.repeat(22),
  action: 'TIMEOUT',
};

const context = {
  classification_id: '20000000-0000-4000-8000-000000000002',
  channel_id: '30000000-0000-4000-8000-000000000003',
  session_id: scope.sessionId,
  external_message_id: 'test-message',
};

function message(rawText, authorId = scope.authorChannelId) {
  return {
    external_message_id: 'test-message',
    author_external_id: authorId,
    author_display_name: 'Test viewer',
    raw_text: rawText,
    published_at: '2026-01-01T00:00:00Z',
  };
}

for (const action of ['TIMEOUT', 'BAN']) {
  test(`${action} requires the exact marker, author and session`, async () => {
    const policy = controlledBanPolicy({ ...scope, action });
    const marker = action === 'TIMEOUT' ? CONTROLLED_TIMEOUT_MESSAGE : CONTROLLED_BAN_MESSAGE;
    const otherMarker = action === 'TIMEOUT' ? CONTROLLED_BAN_MESSAGE : CONTROLLED_TIMEOUT_MESSAGE;

    const signals = await policy.engine.detect(message(marker));
    const plan = policy.planner.plan({ ...context, signals });

    assert.equal(plan.action, action);
    assert.equal(plan.author_channel_id, scope.authorChannelId);
    assert.equal(plan.policy_version, policy.version);

    if (action === 'TIMEOUT') {
      assert.equal(plan.duration_seconds, CONTROLLED_TIMEOUT_SECONDS);
    } else {
      assert.equal('duration_seconds' in plan, false);
    }

    assert.equal(
      policy.planner.plan({
        ...context,
        session_id: context.channel_id,
        signals,
      }).action,
      'NONE',
    );

    for (const text of [
      'Hello test',
      'bodoh',
      otherMarker,
      `${marker} extra`,
      `${marker}\n`,
      `${marker}\r\n`,
      ` ${marker}`,
      `${marker} `,
      marker.toLowerCase(),
      `prefix ${marker}`,
    ]) {
      assert.equal(
        policy.planner.plan({
          ...context,
          signals: await policy.engine.detect(message(text)),
        }).action,
        'NONE',
        `Unexpected action for ${JSON.stringify(text)}`,
      );
    }

    assert.equal(
      policy.planner.plan({
        ...context,
        signals: await policy.engine.detect(message(marker, 'UC' + 'b'.repeat(22))),
      }).action,
      'NONE',
    );
  });
}

test('signals cannot be reused across controlled scopes or actions', async () => {
  const first = controlledBanPolicy(scope);
  const signals = await first.engine.detect(message(CONTROLLED_TIMEOUT_MESSAGE));

  for (const changed of [
    { ...scope, authorChannelId: 'UC' + 'b'.repeat(22) },
    { ...scope, sessionId: context.channel_id },
    { ...scope, action: 'BAN' },
  ]) {
    const policy = controlledBanPolicy(changed);

    assert.equal(
      policy.planner.plan({
        ...context,
        session_id: changed.sessionId,
        signals,
      }).action,
      'NONE',
    );
  }
});

test('controlled policy versions are deterministic and scope-specific', () => {
  const version = controlledBanVersion(scope);
  assert.equal(version, controlledBanVersion({ ...scope }));
  assert.ok(version.length <= 128);

  for (const changed of [
    { ...scope, authorChannelId: 'UC' + 'b'.repeat(22) },
    { ...scope, sessionId: context.channel_id },
    { ...scope, action: 'BAN' },
  ]) {
    assert.notEqual(version, controlledBanVersion(changed));
  }
});

test('invalid controlled scopes are rejected', () => {
  for (const changed of [
    { ...scope, sessionId: 'invalid' },
    { ...scope, authorChannelId: 'invalid' },
    { ...scope, action: 'DELETE' },
  ]) {
    assert.throws(() => controlledBanPolicy(changed));
  }
});
