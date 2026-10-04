const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { AutomaticAiRunReader } = source('apps/worker/src/ingestion/automatic-ai-run-reader.ts');

const model = {
  model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8',
  adapter_version: 'laskar-shadow-1',
};
const runId = 'a0000000-0000-4000-8000-000000000001';
const channelId = 'b0000000-0000-4000-8000-000000000002';
const sessionId = 'c0000000-0000-4000-8000-000000000003';

function row(overrides = {}) {
  return {
    run_id: runId,
    channel_id: channelId,
    session_id: sessionId,
    status: 'RUNNING',
    stop_requested_at: null,
    finished_at: null,
    session_source: 'YOUTUBE',
    closed_at: null,
    chat_ended_at: null,
    snapshot: {
      source: 'SAVED',
      run_id: runId,
      channel_id: channelId,
      settings_id: 'd0000000-0000-4000-8000-000000000004',
      settings_revision: 1,
      configuration: {
        schema_version: 1,
        automatic_actions_enabled: true,
        model: { ...model },
        score_metric: 'EXPECTED_SEVERITY',
        delete: { enabled: true, threshold: 0.5 },
        timeout: { enabled: true, threshold: 0.7, duration_seconds: 30 },
        ban: { enabled: false, threshold: 0.9 },
      },
    },
    ...overrides,
  };
}

test('discovers a saved enabled run without receiving an environment run ID', async () => {
  let reads = 0;
  const reader = new AutomaticAiRunReader(
    {
      async query(sql, values) {
        reads++;
        assert.deepEqual(values, [JSON.stringify(model)]);
        assert.ok(sql.includes('monitoring_ai_settings_snapshots'));
        assert.ok(!sql.includes('ai_moderation_settings_revisions'));
        return { rows: [row()] };
      },
    },
    model,
  );
  assert.deepEqual(await reader.next(), {
    kind: 'SELECTED',
    run_id: runId,
    channel_id: channelId,
    session_id: sessionId,
    snapshot: row().snapshot,
  });
  assert.equal(reads, 1);
});

test('re-reads discovery so a stopped run is replaced by the next eligible run', async () => {
  const nextRun = 'e0000000-0000-4000-8000-000000000005';
  let reads = 0;
  const reader = new AutomaticAiRunReader(
    {
      async query() {
        reads++;
        if (reads === 1) return { rows: [row()] };
        if (reads === 2) return { rows: [] };
        return {
          rows: [row({ run_id: nextRun, snapshot: { ...row().snapshot, run_id: nextRun } })],
        };
      },
    },
    model,
  );
  assert.equal((await reader.next()).run_id, runId);
  assert.deepEqual(await reader.next(), { kind: 'IDLE' });
  assert.equal((await reader.next()).run_id, nextRun);
});

test('refuses to select among simultaneous eligible streams', async () => {
  const nextRun = 'e0000000-0000-4000-8000-000000000005';
  const reader = new AutomaticAiRunReader(
    {
      async query() {
        return {
          rows: [row(), row({ run_id: nextRun, snapshot: { ...row().snapshot, run_id: nextRun } })],
        };
      },
    },
    model,
  );
  assert.deepEqual(await reader.next(), { kind: 'CAPACITY_EXCEEDED' });
});

test('rejects inactive runs and ended or foreign sessions before returning a selection', async () => {
  for (const overrides of [
    { status: 'STARTING' },
    { status: 'STOPPED' },
    { stop_requested_at: '2026-10-04T12:00:00Z' },
    { finished_at: '2026-10-04T12:00:00Z' },
    { session_source: 'DEMO' },
    { closed_at: '2026-10-04T12:00:00Z' },
    { chat_ended_at: '2026-10-04T12:00:00Z' },
    { session_id: 'invalid' },
  ]) {
    const reader = new AutomaticAiRunReader(
      {
        async query() {
          return { rows: [row(overrides)] };
        },
      },
      model,
    );
    await assert.rejects(reader.next());
  }
});

test('missing, foreign, default, and disabled snapshots fail closed', async () => {
  const saved = row().snapshot;
  for (const snapshot of [
    null,
    { ...saved, run_id: channelId },
    { ...saved, channel_id: runId },
    { ...saved, settings_revision: 0 },
    {
      ...saved,
      source: 'DEFAULT',
      settings_id: null,
      settings_revision: null,
      configuration: null,
    },
    {
      ...saved,
      configuration: { ...saved.configuration, automatic_actions_enabled: false },
    },
  ]) {
    const reader = new AutomaticAiRunReader(
      {
        async query() {
          return { rows: [row({ snapshot })] };
        },
      },
      model,
    );
    await assert.rejects(reader.next());
  }
});

test('requires all captured model identity fields to match the available model', async () => {
  for (const changed of [
    { model_id: 'other/model' },
    { model_revision: 'b'.repeat(40) },
    { model_variant: 'FP32' },
    { adapter_version: 'another-adapter' },
  ]) {
    const saved = row().snapshot;
    const snapshot = {
      ...saved,
      configuration: { ...saved.configuration, model: { ...model, ...changed } },
    };
    const reader = new AutomaticAiRunReader(
      {
        async query() {
          return { rows: [row({ snapshot })] };
        },
      },
      model,
    );
    await assert.rejects(reader.next());
  }
});

test('cancellation before or during discovery does not return an eligible run', async () => {
  const controller = new AbortController();
  let reads = 0;
  const reader = new AutomaticAiRunReader(
    {
      async query() {
        reads++;
        controller.abort();
        return { rows: [row()] };
      },
    },
    model,
  );
  assert.deepEqual(await reader.next(controller.signal), { kind: 'CANCELLED' });
  assert.deepEqual(await reader.next(controller.signal), { kind: 'CANCELLED' });
  assert.equal(reads, 1);
});

test('database failures propagate and later discovery can recover', async () => {
  let reads = 0;
  const reader = new AutomaticAiRunReader(
    {
      async query() {
        if (++reads === 1) throw new Error('Database unavailable');
        return { rows: [row()] };
      },
    },
    model,
  );
  await assert.rejects(reader.next(), /Database unavailable/);
  assert.equal((await reader.next()).kind, 'SELECTED');
});

test('invalid worker model identity is rejected before any database access', () => {
  assert.throws(() => new AutomaticAiRunReader({}, { ...model, model_revision: 'main' }));
});
