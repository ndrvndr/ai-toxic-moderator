const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { RunSettingsPlanner } = source('apps/worker/src/ingestion/run-settings-planner.ts');
const observation = {
  runId: '10000000-0000-4000-8000-000000000001',
  channelId: '20000000-0000-4000-8000-000000000002',
  sessionId: '30000000-0000-4000-8000-000000000003',
};
const fallback = { schema_version: 1, automatic_actions_enabled: false, rules: [] };
function row(overrides = {}) {
  return {
    run_id: observation.runId,
    settings_id: null,
    settings_revision: null,
    source: 'DEFAULT',
    configuration: fallback,
    ...overrides,
  };
}
test('snapshot reads bind run, channel and session through the supplied transaction client', async () => {
  const planner = await new RunSettingsPlanner().resolve(
    {
      async query(sql, params) {
        assert.deepEqual(params, [observation.runId, observation.channelId, observation.sessionId]);
        assert.match(sql, /run.session_id = \$3/);
        assert.equal(sql.includes('ORDER BY revision'), false);
        return { rows: [row()] };
      },
    },
    observation,
  );
  const result = planner.plan({
    classification_id: observation.runId,
    channel_id: observation.channelId,
    session_id: observation.sessionId,
    external_message_id: 'message',
    signals: [],
  });
  assert.equal(result.policy_version, `settings-run-${observation.runId}`);
  assert.equal(result.action, 'NONE');
});

test('missing, mismatched and malformed snapshots fail without choosing a fallback policy', async () => {
  for (const rows of [
    [],
    [row({ run_id: observation.sessionId })],
    [row({ configuration: {} })],
    [row({ source: 'SAVED' })],
    [row({ source: 'LEGACY', configuration: { ...fallback, automatic_actions_enabled: true } })],
  ]) {
    await assert.rejects(
      new RunSettingsPlanner().resolve(
        {
          async query() {
            return { rows };
          },
        },
        observation,
      ),
    );
  }
});

test('legacy snapshots remain classification only', async () => {
  const planner = await new RunSettingsPlanner().resolve(
    {
      async query() {
        return { rows: [row({ source: 'LEGACY' })] };
      },
    },
    observation,
  );
  assert.equal(
    planner.plan({
      classification_id: observation.runId,
      channel_id: observation.channelId,
      session_id: observation.sessionId,
      external_message_id: 'message',
      signals: [],
    }).action,
    'NONE',
  );
});
