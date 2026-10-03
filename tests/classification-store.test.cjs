const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { ClassificationStore, toMessageInput } = source(
  'apps/worker/src/ingestion/classification-store.ts',
);

const observation = {
  channelId: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000002',
  observationId: '30000000-0000-4000-8000-000000000003',
  externalMessageId: 'external-message-1',
  runId: '40000000-0000-4000-8000-000000000004',
  publishedAt: '2026-09-20T00:00:00.000Z',
  payload: {
    snippet: {
      type: 'textMessageEvent',
      liveChatId: 'chat-1',
      publishedAt: '2026-09-20T00:00:00.000Z',
      displayMessage: 'Hello viewer',
      textMessageDetails: {
        messageText: 'Hello viewer',
      },
    },
    authorDetails: {
      channelId: 'viewer-1',
      displayName: 'Test viewer',
    },
  },
};

test('replayed classification plans from persisted signals using the same client', async () => {
  const stored = {
    id: '50000000-0000-4000-8000-000000000005',
    outcome: 'ALLOW',
    primary_category: null,
    severity: 0,
    reason_code: 'NO_RULE_MATCH',
    reason: 'Previously evaluated message.',
    signals: [],
  };
  let queries = 0;
  let saves = 0;
  const client = {
    async query() {
      queries++;
      return { rows: queries === 1 ? [] : [stored] };
    },
  };
  const expectedPlan = {
    classification_id: stored.id,
    channel_id: observation.channelId,
    session_id: observation.sessionId,
    policy_version: 'actions-1',
    action: 'NONE',
    reason: 'No action selected.',
  };
  const store = new ClassificationStore(
    {
      async detect() {
        return [];
      },
    },
    {
      evaluate() {
        return { ...stored, reason: 'New computation', signals: [{ rule_id: 'new-result' }] };
      },
    },
    'rules-1',
    'policy-1',
    {
      planner: {
        plan(input) {
          assert.equal(input.classification_id, stored.id);
          assert.deepEqual(input.signals, []);
          assert.equal(input.external_message_id, observation.externalMessageId);
          return expectedPlan;
        },
      },
      store: {
        async save(receivedClient, plan) {
          assert.equal(receivedClient, client);
          assert.deepEqual(plan, expectedPlan);
          saves++;
        },
      },
    },
  );
  const result = await store.classify(client, observation);
  assert.equal(result.classificationId, stored.id);
  assert.equal(result.decision.reason, stored.reason);
  assert.equal(queries, 2);
  assert.equal(saves, 1);
});

test('YouTube payload is converted to MessageInput', () => {
  assert.deepEqual(toMessageInput(observation), {
    external_message_id: observation.externalMessageId,
    author_external_id: 'viewer-1',
    author_display_name: 'Test viewer',
    raw_text: 'Hello viewer',
    published_at: observation.publishedAt,
  });
});

test('non-text events are skipped', () => {
  assert.equal(
    toMessageInput({
      ...observation,
      payload: {
        snippet: {
          type: 'tombstone',
          liveChatId: 'chat-1',
          publishedAt: observation.publishedAt,
        },
      },
    }),
    null,
  );
});

test('classification is persisted with the selected versions', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      return {
        rowCount: 1,
        rows: [
          {
            id: params[0],
            outcome: params[7],
            primary_category: params[8],
            severity: params[9],
            reason_code: params[10],
            reason: params[11],
            signals: JSON.parse(params[12]),
          },
        ],
      };
    },
  };

  const engine = {
    async detect() {
      return [];
    },
  };

  const policy = {
    evaluate(signals) {
      assert.deepEqual(signals, []);

      return {
        outcome: 'ALLOW',
        primary_category: null,
        severity: 0,
        reason_code: 'NO_RULE_MATCH',
        reason: 'No configured rule matched this message.',
        signals: [],
      };
    },
  };

  const store = new ClassificationStore(engine, policy, 'rules-1', 'policy-1');

  const result = await store.classify(client, observation);

  assert.equal(result.classified, true);
  assert.equal(result.decision.outcome, 'ALLOW');
  assert.equal(result.classificationId, queries[0].params[0]);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /ON CONFLICT\(observation_id, classifier_version, policy_version\)/);
  assert.equal(queries[0].params[5], 'rules-1');
  assert.equal(queries[0].params[6], 'policy-1');
});

test('classification does not write non-text events', async () => {
  const client = {
    async query() {
      throw new Error('The database must not be called.');
    },
  };

  const store = new ClassificationStore(
    {
      async detect() {
        return [];
      },
    },
    {
      evaluate() {
        throw new Error('The policy must not be called.');
      },
    },
    'rules-1',
    'policy-1',
  );

  const result = await store.classify(client, {
    ...observation,
    payload: {
      snippet: {
        type: 'tombstone',
        liveChatId: 'chat-1',
        publishedAt: observation.publishedAt,
      },
    },
  });

  assert.deepEqual(result, { classified: false });
});

test('snapshot planning on replay uses the original classification run and persisted signals', async () => {
  const originalRun = '60000000-0000-4000-8000-000000000006';
  const stored = {
    id: '50000000-0000-4000-8000-000000000005',
    run_id: originalRun,
    outcome: 'ALLOW',
    primary_category: null,
    severity: 0,
    reason_code: 'NO_RULE_MATCH',
    reason: 'Persisted decision.',
    signals: [],
  };
  let queries = 0;
  let saved = false;
  const client = {
    async query() {
      return { rows: ++queries === 1 ? [] : [stored] };
    },
  };
  const store = new ClassificationStore(
    {
      async detect() {
        return [];
      },
    },
    {
      evaluate() {
        return { ...stored, signals: [{ rule_id: 'new-computation' }] };
      },
    },
    'rules-1',
    'policy-1',
    {
      planner: {
        plan() {
          throw new Error('The fixed planner must not be used.');
        },
      },
      async resolvePlanner(receivedClient, receivedObservation) {
        assert.equal(receivedClient, client);
        assert.equal(receivedObservation.runId, originalRun);
        assert.equal(receivedObservation.channelId, observation.channelId);
        return {
          plan(input) {
            assert.deepEqual(input.signals, stored.signals);
            assert.equal(input.author_channel_id, 'viewer-1');
            return {
              classification_id: stored.id,
              channel_id: observation.channelId,
              session_id: observation.sessionId,
              policy_version: `settings-run-${originalRun}`,
              action: 'NONE',
              reason: 'Original run configuration.',
            };
          },
        };
      },
      store: {
        async save(receivedClient, plan) {
          assert.equal(receivedClient, client);
          assert.equal(plan.policy_version, `settings-run-${originalRun}`);
          saved = true;
        },
      },
    },
  );
  const result = await store.classify(client, observation);
  assert.equal(saved, true);
  assert.equal('run_id' in result.decision, false);
});
