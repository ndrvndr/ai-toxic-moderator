const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { ActionPlanStore } = source('apps/worker/src/ingestion/action-plan-store.ts');

const plan = {
  classification_id: '10000000-0000-4000-8000-000000000001',
  channel_id: '20000000-0000-4000-8000-000000000002',
  session_id: '30000000-0000-4000-8000-000000000003',
  policy_version: 'actions-1',
  action: 'DELETE',
  external_message_id: 'message-1',
  reason: 'An enabled rule selected deletion.',
};

const observation = {
  external_message_id: 'message-1',
  author_channel_id: 'author-1',
};

function storedRow(input = plan) {
  return {
    id: '40000000-0000-4000-8000-000000000004',
    channel_id: input.channel_id,
    session_id: input.session_id,
    classification_id: input.classification_id,
    policy_version: input.policy_version,
    action: input.action,
    duration_seconds: input.action === 'TIMEOUT' ? String(input.duration_seconds) : null,
    reason: input.reason,
  };
}

function mockClient(results) {
  const calls = [];

  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });

      const result = results.shift();

      assert.ok(result, 'Unexpected database query.');
      return result;
    },
  };
}

test('a matching message target can be persisted', async () => {
  const client = mockClient([{ rows: [observation] }, { rows: [storedRow()] }]);

  const result = await new ActionPlanStore().save(client, plan);

  assert.equal(result.reused, false);
  assert.deepEqual(result.plan, plan);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].params[5], 'DELETE');
});

test('an unavailable classification is rejected before insertion', async () => {
  const client = mockClient([{ rows: [] }]);

  await assert.rejects(new ActionPlanStore().save(client, plan), /classification was not found/);

  assert.equal(client.calls.length, 1);
});

test('a substituted message target is rejected before insertion', async () => {
  const client = mockClient([{ rows: [observation] }]);

  await assert.rejects(
    new ActionPlanStore().save(client, {
      ...plan,
      external_message_id: 'another-message',
    }),
    /deletion target does not match/,
  );

  assert.equal(client.calls.length, 1);
});

test('a substituted author is rejected before insertion', async () => {
  const { external_message_id, ...context } = plan;
  const client = mockClient([{ rows: [observation] }]);

  await assert.rejects(
    new ActionPlanStore().save(client, {
      ...context,
      action: 'BAN',
      author_channel_id: 'another-author',
    }),
    /moderation target does not match/,
  );

  assert.equal(client.calls.length, 1);
});

test('an identical existing plan is reused', async () => {
  const client = mockClient([{ rows: [observation] }, { rows: [] }, { rows: [storedRow()] }]);

  const result = await new ActionPlanStore().save(client, plan);

  assert.equal(result.reused, true);
  assert.equal(result.id, storedRow().id);
  assert.deepEqual(result.plan, plan);
});

test('a conflicting decision cannot reuse the same policy version', async () => {
  const client = mockClient([
    { rows: [observation] },
    { rows: [] },
    { rows: [{ ...storedRow(), action: 'NONE' }] },
  ]);

  await assert.rejects(
    new ActionPlanStore().save(client, plan),
    /incompatible plan already exists/,
  );
});
