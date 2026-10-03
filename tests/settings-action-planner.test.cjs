const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { SettingsActionPlanner, RuleDetectionEngine } = source(
  'packages/moderation-core/src/index.ts',
);
const { DEFAULT_RULES } = source('apps/worker/src/ingestion/default-rules.ts');
const context = {
  classification_id: '10000000-0000-4000-8000-000000000001',
  channel_id: '20000000-0000-4000-8000-000000000002',
  session_id: '30000000-0000-4000-8000-000000000003',
  external_message_id: 'message-1',
  author_channel_id: 'UC' + 'a'.repeat(22),
};
const rule = {
  rule_id: 'id.harassment.direct-insult',
  rule_version: '1',
  minimum_severity: 2,
};
function configuration(action = 'DELETE', enabled = true) {
  return {
    schema_version: 1,
    automatic_actions_enabled: enabled,
    rules: [{ ...rule, action, ...(action === 'TIMEOUT' ? { duration_seconds: 30 } : {}) }],
  };
}
async function detect(text) {
  return new RuleDetectionEngine(DEFAULT_RULES).detect({
    external_message_id: context.external_message_id,
    author_external_id: context.author_channel_id,
    author_display_name: 'Test viewer',
    raw_text: text,
    published_at: '2026-01-01T00:00:00Z',
  });
}

test('supported strong detections select delete, timeout and ban with their correct targets', async () => {
  const signals = await detect('idiot');
  assert.ok(signals.length);
  for (const action of ['DELETE', 'TIMEOUT', 'BAN']) {
    const result = new SettingsActionPlanner(configuration(action), 'settings-run-test').plan({
      ...context,
      signals,
    });
    assert.equal(result.action, action);
    assert.equal(result.policy_version, 'settings-run-test');
    if (action === 'DELETE') {
      assert.equal(result.external_message_id, context.external_message_id);
      assert.equal('author_channel_id' in result, false);
    } else {
      assert.equal(result.author_channel_id, context.author_channel_id);
      assert.equal('external_message_id' in result, false);
    }
    if (action === 'TIMEOUT') assert.equal(result.duration_seconds, 30);
    else assert.equal('duration_seconds' in result, false);
  }
});

test('disabled settings, empty rules, safe messages and higher severity thresholds select no action', async () => {
  const signals = await detect('idiot');
  for (const config of [
    configuration('BAN', false),
    { ...configuration(), rules: [] },
    { ...configuration(), rules: [{ ...rule, minimum_severity: 3, action: 'DELETE' }] },
  ])
    assert.equal(
      new SettingsActionPlanner(config, 'test').plan({ ...context, signals }).action,
      'NONE',
    );
  assert.equal(
    new SettingsActionPlanner(configuration(), 'test').plan({
      ...context,
      signals: await detect('Hello test'),
    }).action,
    'NONE',
  );
});

test('ambiguous, unknown, outdated and mismatched category signals cannot enable actions', async () => {
  const [strong] = await detect('idiot');
  for (const entry of [
    { ...strong, strength: 'AMBIGUOUS' },
    { ...strong, rule_version: '2' },
    { ...strong, category: 'SPAM' },
    { ...strong, rule_id: 'development.fake-test' },
  ])
    assert.equal(
      new SettingsActionPlanner(configuration(), 'test').plan({ ...context, signals: [entry] })
        .action,
      'NONE',
    );
  const ambiguous = {
    schema_version: 1,
    automatic_actions_enabled: true,
    rules: [
      {
        rule_id: 'id.gambling.promotion',
        rule_version: '1',
        minimum_severity: 1,
        action: 'BAN',
      },
    ],
  };
  assert.equal(
    new SettingsActionPlanner(ambiguous, 'test').plan({
      ...context,
      signals: await detect('slot gacor'),
    }).action,
    'NONE',
  );
});

test('author actions reject missing or fallback targets while deletion remains message scoped', async () => {
  const signals = await detect('idiot');
  for (const author_channel_id of [undefined, '', 'unknown-author', 'viewer-1']) {
    for (const action of ['TIMEOUT', 'BAN'])
      assert.equal(
        new SettingsActionPlanner(configuration(action), 'test').plan({
          ...context,
          author_channel_id,
          signals,
        }).action,
        'NONE',
      );
  }
  assert.equal(
    new SettingsActionPlanner(configuration(), 'test').plan({
      ...context,
      author_channel_id: undefined,
      signals,
    }).action,
    'DELETE',
  );
});

test('planner owns its parsed configuration and does not follow subsequent draft mutation', async () => {
  const config = configuration('TIMEOUT');
  const planner = new SettingsActionPlanner(config, 'test');
  config.automatic_actions_enabled = false;
  config.rules[0].duration_seconds = 120;
  const result = planner.plan({ ...context, signals: await detect('idiot') });
  assert.equal(result.action, 'TIMEOUT');
  assert.equal(result.duration_seconds, 30);
});
