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
      return { rowCount: 1 };
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
