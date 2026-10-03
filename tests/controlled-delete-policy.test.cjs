const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { controlledDeletePolicy, controlledDeleteVersion, CONTROLLED_DELETE_MESSAGE } = source(
  'apps/worker/src/ingestion/controlled-delete-policy.ts',
);
const { createClassificationStore } = source(
  'apps/worker/src/ingestion/create-classification-store.ts',
);
const { loadConfig } = source('packages/config/src/index.ts');
const scope = {
  sessionId: '10000000-0000-4000-8000-000000000001',
  authorChannelId: 'UC' + 'a'.repeat(22),
};
const input = {
  external_message_id: 'message',
  author_external_id: scope.authorChannelId,
  author_display_name: 'Test viewer',
  raw_text: CONTROLLED_DELETE_MESSAGE,
  published_at: '2026-01-01T00:00:00Z',
};
const context = {
  classification_id: '20000000-0000-4000-8000-000000000002',
  channel_id: '30000000-0000-4000-8000-000000000003',
  session_id: scope.sessionId,
  external_message_id: 'message',
};

test('only the exact marker from the configured author and session selects DELETE', async () => {
  const policy = controlledDeletePolicy(scope);
  const signals = await policy.engine.detect(input);
  assert.equal(policy.planner.plan({ ...context, signals }).action, 'DELETE');
  assert.equal(
    policy.planner.plan({ ...context, session_id: context.channel_id, signals }).action,
    'NONE',
  );
  for (const text of [
    'hello',
    'bodoh',
    'ATM_DELETE_TEST_V1\n',
    ' ATM_DELETE_TEST_V1',
    'ATM_DELETE_TEST_V1 ',
    'atm_delete_test_v1',
    'prefix ATM_DELETE_TEST_V1',
  ]) {
    assert.equal(
      policy.planner.plan({
        ...context,
        signals: await policy.engine.detect({ ...input, raw_text: text }),
      }).action,
      'NONE',
    );
  }
  assert.equal(
    policy.planner.plan({
      ...context,
      signals: await policy.engine.detect({ ...input, author_external_id: 'other' }),
    }).action,
    'NONE',
  );
});

test('scope changes produce different immutable policy versions', () => {
  assert.equal(controlledDeleteVersion(scope), controlledDeleteVersion({ ...scope }));
  assert.notEqual(
    controlledDeleteVersion(scope),
    controlledDeleteVersion({ ...scope, authorChannelId: 'other' }),
  );
  assert.notEqual(
    controlledDeleteVersion(scope),
    controlledDeleteVersion({ ...scope, sessionId: context.channel_id }),
  );
});

test('the actual classification factory remains opt-in and persists a test plan when scoped', async () => {
  for (const enabled of [false, true]) {
    const plans = [];
    const store = createClassificationStore(
      {
        async save(_client, plan) {
          plans.push(plan);
        },
      },
      enabled ? scope : undefined,
    );
    let snapshotReads = 0;
    const client = {
      async query(sql, params) {
        if (sql.includes('FROM monitoring_settings_snapshots')) {
          assert.equal(enabled, false, 'Controlled policy must not read normal settings.');
          assert.deepEqual(params, [
            context.classification_id,
            context.channel_id,
            scope.sessionId,
          ]);
          snapshotReads++;
          return {
            rows: [
              {
                run_id: params[0],
                settings_id: null,
                settings_revision: null,
                source: 'DEFAULT',
                configuration: { schema_version: 1, automatic_actions_enabled: false, rules: [] },
              },
            ],
          };
        }
        assert.match(sql, /INSERT INTO youtube_chat_classifications/);
        return {
          rows: [
            {
              id: params[0],
              run_id: params[4],
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
    await store.classify(client, {
      channelId: context.channel_id,
      sessionId: scope.sessionId,
      observationId: context.classification_id,
      externalMessageId: 'message',
      runId: context.classification_id,
      publishedAt: input.published_at,
      payload: {
        snippet: { textMessageDetails: { messageText: input.raw_text } },
        authorDetails: { channelId: scope.authorChannelId, displayName: 'Test viewer' },
      },
    });
    assert.equal(plans.length, 1);
    assert.equal(plans[0].action, enabled ? 'DELETE' : 'NONE');
    assert.equal(
      plans[0].policy_version,
      enabled ? controlledDeleteVersion(scope) : `settings-run-${context.classification_id}`,
    );
    assert.equal(snapshotReads, enabled ? 0 : 1);
  }
});

test('test configuration defaults empty and rejects partial or malformed scopes', () => {
  const env = { DATABASE_URL: 'postgresql://test:test@127.0.0.1/test' };
  assert.equal(loadConfig(env).YOUTUBE_DELETE_TEST_SESSION_ID, '');
  assert.throws(() => loadConfig({ ...env, YOUTUBE_DELETE_TEST_SESSION_ID: scope.sessionId }));
  assert.throws(() => loadConfig({ ...env, YOUTUBE_DELETE_TEST_AUTHOR_ID: scope.authorChannelId }));
  assert.throws(() =>
    loadConfig({
      ...env,
      YOUTUBE_DELETE_TEST_SESSION_ID: 'broadcast-id',
      YOUTUBE_DELETE_TEST_AUTHOR_ID: scope.authorChannelId,
    }),
  );
  assert.throws(() =>
    loadConfig({
      ...env,
      YOUTUBE_DELETE_TEST_SESSION_ID: scope.sessionId,
      YOUTUBE_DELETE_TEST_AUTHOR_ID: 'invalid',
    }),
  );
});
