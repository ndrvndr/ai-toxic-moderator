const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { moderationActionPlan } = source('packages/contracts/src/moderation-action.ts');

const context = {
  classification_id: '10000000-0000-4000-8000-000000000001',
  channel_id: '20000000-0000-4000-8000-000000000002',
  session_id: '30000000-0000-4000-8000-000000000003',
  policy_version: 'actions-1',
  reason: 'The configured policy selected this action.',
};

test('no action can be recorded without a provider target', () => {
  const plan = { ...context, action: 'NONE' };
  assert.deepEqual(moderationActionPlan.parse(plan), plan);
});

test('deletion requires a message ID', () => {
  assert.equal(
    moderationActionPlan.safeParse({
      ...context,
      action: 'DELETE',
      external_message_id: 'message-1',
    }).success,
    true,
  );

  assert.equal(
    moderationActionPlan.safeParse({
      ...context,
      action: 'DELETE',
      author_channel_id: 'author-1',
    }).success,
    false,
  );
});

test('timeout requires an author and a positive integer duration', () => {
  const plan = {
    ...context,
    action: 'TIMEOUT',
    author_channel_id: 'author-1',
    duration_seconds: 300,
  };

  assert.deepEqual(moderationActionPlan.parse(plan), plan);

  for (const duration of [0, -1, 1.5, Infinity, undefined]) {
    assert.equal(
      moderationActionPlan.safeParse({
        ...plan,
        duration_seconds: duration,
      }).success,
      false,
    );
  }

  const { author_channel_id, ...withoutAuthor } = plan;
  assert.equal(moderationActionPlan.safeParse(withoutAuthor).success, false);
});

test('permanent bans do not accept timeout durations', () => {
  const plan = {
    ...context,
    action: 'BAN',
    author_channel_id: 'author-1',
  };

  assert.deepEqual(moderationActionPlan.parse(plan), plan);
  assert.equal(
    moderationActionPlan.safeParse({
      ...plan,
      duration_seconds: 300,
    }).success,
    false,
  );
});

test('an action plan cannot claim execution success', () => {
  assert.equal(
    moderationActionPlan.safeParse({
      ...context,
      action: 'DELETE',
      external_message_id: 'message-1',
      status: 'SUCCEEDED',
    }).success,
    false,
  );
});
