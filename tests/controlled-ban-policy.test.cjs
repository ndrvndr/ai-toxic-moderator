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

const { loadConfig } = source('packages/config/src/index.ts');
const { createClassificationStore } = source(
  'apps/worker/src/ingestion/create-classification-store.ts',
);

test('controlled ban configuration requires a complete scope', () => {
  const base = {
    DATABASE_URL: 'postgresql://test:test@127.0.0.1/test',
  };
  const fields = {
    YOUTUBE_BAN_TEST_SESSION_ID: scope.sessionId,
    YOUTUBE_BAN_TEST_AUTHOR_ID: scope.authorChannelId,
    YOUTUBE_BAN_TEST_ACTION: 'TIMEOUT',
  };

  const defaults = loadConfig(base);
  assert.equal(defaults.YOUTUBE_BAN_TEST_SESSION_ID, '');
  assert.equal(defaults.YOUTUBE_BAN_TEST_AUTHOR_ID, '');
  assert.equal(defaults.YOUTUBE_BAN_TEST_ACTION, '');

  for (const key of Object.keys(fields)) {
    assert.throws(() => loadConfig({ ...base, [key]: fields[key] }));
    assert.throws(() => loadConfig({ ...base, ...fields, [key]: '' }));
  }

  assert.equal(loadConfig({ ...base, ...fields }).YOUTUBE_BAN_TEST_ACTION, 'TIMEOUT');
  assert.throws(() => loadConfig({ ...base, ...fields, YOUTUBE_BAN_TEST_ACTION: 'DELETE' }));
});

test('both controlled policies cannot be enabled together', () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: 'postgresql://test:test@127.0.0.1/test',
        WORKER_ENABLED: 'true',
        GOOGLE_AUTH_ENABLED: 'true',
        YOUTUBE_DELETE_ENABLED: 'true',
        YOUTUBE_DELETE_TEST_SESSION_ID: scope.sessionId,
        YOUTUBE_DELETE_TEST_AUTHOR_ID: scope.authorChannelId,
        YOUTUBE_BAN_ENABLED: 'true',
        YOUTUBE_BAN_TEST_SESSION_ID: scope.sessionId,
        YOUTUBE_BAN_TEST_AUTHOR_ID: scope.authorChannelId,
        YOUTUBE_BAN_TEST_ACTION: 'TIMEOUT',
      }),
    /cannot run simultaneously/,
  );

  assert.throws(
    () => createClassificationStore(undefined, scope, scope),
    /Only one controlled action policy/,
  );
});

test('classification factory persists controlled author plans only when scoped', async () => {
  for (const action of ['TIMEOUT', 'BAN']) {
    for (const enabled of [false, true]) {
      const plans = [];
      const store = createClassificationStore(
        {
          async save(_client, plan) {
            plans.push(plan);
          },
        },
        undefined,
        enabled ? { ...scope, action } : undefined,
        {
          async save(_client, bundle) {
            assert.equal(enabled, false);
            assert.equal(bundle.source, 'DEFAULT');
            assert.deepEqual(bundle.plans, []);
          },
        },
      );

      let snapshotReads = 0;
      const client = {
        async query(sql, params) {
          if (sql.includes('FROM youtube_chat_classifications')) return { rows: [] };
          if (sql.includes('FROM monitoring_blacklist_snapshots')) {
            assert.equal(enabled, false);
            return {
              rows: [
                {
                  run_id: params[0],
                  channel_id: params[1],
                  session_id: params[2],
                  blacklist_id: null,
                  blacklist_revision: null,
                  source: 'DEFAULT',
                  configuration: { schema_version: 1, enabled: false, rules: [] },
                },
              ],
            };
          }
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
        externalMessageId: 'test-message',
        runId: context.classification_id,
        publishedAt: '2026-01-01T00:00:00Z',
        payload: {
          snippet: {
            textMessageDetails: {
              messageText:
                action === 'TIMEOUT' ? CONTROLLED_TIMEOUT_MESSAGE : CONTROLLED_BAN_MESSAGE,
            },
          },
          authorDetails: {
            channelId: scope.authorChannelId,
            displayName: 'Test viewer',
          },
        },
      });

      assert.equal(plans.length, 1);
      assert.equal(plans[0].action, enabled ? action : 'NONE');
      assert.equal(
        plans[0].policy_version,
        enabled
          ? controlledBanVersion({ ...scope, action })
          : `settings-run-${context.classification_id}`,
      );
      assert.equal(snapshotReads, enabled ? 0 : 1);
    }
  }
});
