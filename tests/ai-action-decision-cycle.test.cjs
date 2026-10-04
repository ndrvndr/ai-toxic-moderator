const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { AiActionDecisionCandidateReader } = source(
  'apps/worker/src/ingestion/ai-action-decision-candidate-reader.ts',
);
const { AiActionDecisionCycle, createAiActionDecisionCycle } = source(
  'apps/worker/src/ingestion/ai-action-decision-cycle.ts',
);

const scope = {
  run_id: '10000000-0000-4000-8000-00000000000a',
  channel_id: '20000000-0000-4000-8000-00000000000b',
  session_id: '30000000-0000-4000-8000-00000000000c',
  observation_id: '40000000-0000-4000-8000-00000000000d',
  classification_id: '50000000-0000-4000-8000-00000000000e',
};
const model = {
  model_id: 'test/model',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8',
  adapter_version: 'laskar-shadow-1',
};
const candidate = { ...scope, model_result_id: '60000000-0000-4000-8000-00000000000f' };
const signal = () => new AbortController().signal;
function row(overrides = {}) {
  return {
    ...candidate,
    text: 'hello viewer',
    received_at: '2026-10-04 12:00:00.123456+00',
    ai_snapshot: {
      run_id: scope.run_id,
      channel_id: scope.channel_id,
      source: 'SAVED',
      settings_id: '70000000-0000-4000-8000-000000000001',
      settings_revision: 1,
      configuration: {
        schema_version: 1,
        automatic_actions_enabled: true,
        model,
        score_metric: 'EXPECTED_SEVERITY',
        delete: { enabled: true, threshold: 0.4 },
        timeout: { enabled: true, threshold: 0.6, duration_seconds: 60 },
        ban: { enabled: false, threshold: 0.9 },
      },
    },
    blacklist_snapshot: {
      run_id: scope.run_id,
      channel_id: scope.channel_id,
      source: 'DEFAULT',
      blacklist_id: null,
      blacklist_revision: null,
      configuration: { schema_version: 1, enabled: false, rules: [] },
    },
    ...overrides,
  };
}

test('factory remains scoped to explicit shadow opt-in and never constructs inference', () => {
  const fail = () => assert.fail('Disabled factory must not access the database.');
  assert.equal(
    createAiActionDecisionCycle({ AI_SHADOW_ENABLED: false }, { query: fail, connect: fail }),
    undefined,
  );
  const config = {
    AI_SHADOW_ENABLED: true,
    AI_SHADOW_RUN_ID: scope.run_id,
    AI_SHADOW_MODEL_REVISION: model.model_revision,
  };
  assert.ok(createAiActionDecisionCycle(config, { query: fail, connect: fail }));
  assert.throws(() => createAiActionDecisionCycle({ ...config, AI_SHADOW_RUN_ID: 'invalid' }, {}));
  assert.throws(() =>
    createAiActionDecisionCycle({ ...config, AI_SHADOW_MODEL_REVISION: 'main' }, {}),
  );
});

test('reader binds exact configured run/model identity and normalizes UUID casing', async () => {
  let queries = 0;
  const reader = new AiActionDecisionCandidateReader(
    {
      async query(sql, values) {
        queries++;
        assert.deepEqual(values, [scope.run_id, ...Object.values(model), null, null]);
        assert.ok(sql.includes("m.status IN ('SUCCEEDED','ERROR')"));
        assert.ok(sql.includes('NOT EXISTS (SELECT 1 FROM youtube_ai_action_decisions'));
        return { rows: [row()] };
      },
    },
    model,
  );
  await assert.rejects(reader.next('invalid'));
  assert.equal(queries, 0);
  assert.deepEqual(await reader.next(scope.run_id.toUpperCase(), signal()), candidate);
});

test('pending inference is skipped without persisting a terminal missing-output decision', async () => {
  let reads = 0;
  const reader = new AiActionDecisionCandidateReader(
    {
      async query() {
        return { rows: ++reads === 1 ? [row({ model_result_id: null })] : [] };
      },
    },
    model,
  );
  const fail = () => assert.fail('Pending inference must not enter an audit transaction.');
  const cycle = new AiActionDecisionCycle(scope.run_id, reader, { connect: fail });
  assert.deepEqual(await cycle.tick(signal()), { kind: 'IDLE' });
  assert.equal(reads, 2);
});

test('pending messages do not starve completed outputs and retain full-precision scan cursors', async () => {
  let reads = 0;
  const nextId = '80000000-0000-4000-8000-000000000001';
  const reader = new AiActionDecisionCandidateReader(
    {
      async query(_sql, values) {
        reads++;
        assert.deepEqual(
          values.slice(5),
          reads === 1 ? [null, null] : [row().received_at, scope.observation_id],
        );
        return {
          rows: [reads === 1 ? row({ model_result_id: null }) : row({ observation_id: nextId })],
        };
      },
    },
    model,
  );
  assert.deepEqual(await reader.next(scope.run_id), { ...candidate, observation_id: nextId });
});

test('captured default, legacy, and disabled policies can audit without waiting for a model', async () => {
  const saved = row().ai_snapshot;
  for (const snapshot of [
    {
      ...saved,
      source: 'DEFAULT',
      settings_id: null,
      settings_revision: null,
      configuration: null,
    },
    { ...saved, source: 'LEGACY', settings_id: null, settings_revision: null, configuration: null },
    { ...saved, configuration: { ...saved.configuration, automatic_actions_enabled: false } },
  ]) {
    const reader = new AiActionDecisionCandidateReader(
      {
        async query() {
          return { rows: [row({ ai_snapshot: snapshot, model_result_id: null })] };
        },
      },
      model,
    );
    assert.deepEqual(await reader.next(scope.run_id), { ...candidate, model_result_id: null });
  }
});

test('blacklist priority is recomputed before waiting for inference', async () => {
  const blacklist = {
    ...row().blacklist_snapshot,
    source: 'SAVED',
    blacklist_id: '90000000-0000-4000-8000-000000000001',
    blacklist_revision: 1,
    configuration: {
      schema_version: 1,
      enabled: true,
      rules: [
        {
          id: '90000000-0000-4000-8000-000000000002',
          enabled: true,
          pattern: 'abc',
          match_type: 'WORD',
          action: 'DELETE',
        },
      ],
    },
  };
  const reader = new AiActionDecisionCandidateReader(
    {
      async query() {
        return {
          rows: [row({ text: 'abc', blacklist_snapshot: blacklist, model_result_id: null })],
        };
      },
    },
    model,
  );
  assert.deepEqual(await reader.next(scope.run_id), { ...candidate, model_result_id: null });
});

test('missing and foreign policy snapshots fail before persistence', async () => {
  for (const overrides of [
    { ai_snapshot: null },
    { blacklist_snapshot: null },
    { ai_snapshot: { ...row().ai_snapshot, run_id: scope.channel_id } },
    { blacklist_snapshot: { ...row().blacklist_snapshot, channel_id: scope.run_id } },
    { run_id: scope.channel_id },
  ]) {
    const reader = new AiActionDecisionCandidateReader(
      {
        async query() {
          return { rows: [row(overrides)] };
        },
      },
      model,
    );
    const cycle = new AiActionDecisionCycle(scope.run_id, reader, {
      connect() {
        assert.fail('Invalid scope must not persist.');
      },
    });
    await assert.rejects(cycle.tick(signal()));
  }
});

test('selection cancellation and invalid text stop work without fabricating decisions', async () => {
  const controller = new AbortController();
  let reads = 0;
  const reader = new AiActionDecisionCandidateReader(
    {
      async query() {
        reads++;
        controller.abort();
        return { rows: [row()] };
      },
    },
    model,
  );
  assert.equal(await reader.next(scope.run_id, controller.signal), null);
  assert.equal(reads, 1);
  const blank = new AiActionDecisionCandidateReader(
    {
      async query() {
        return { rows: ++reads === 2 ? [row({ text: ' ' })] : [] };
      },
    },
    model,
  );
  assert.equal(await blank.next(scope.run_id), null);
});

function harness({ read, save, connect } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
    },
    release() {
      calls.push('release');
    },
  };
  const cycle = new AiActionDecisionCycle(
    scope.run_id,
    {
      async next(runId) {
        assert.equal(runId, scope.run_id);
        calls.push('read');
        return read ? read() : candidate;
      },
    },
    {
      async connect() {
        calls.push('connect');
        if (connect) await connect();
        return client;
      },
    },
    {
      async save(connection, input) {
        calls.push('save');
        assert.equal(connection, client);
        assert.deepEqual(input, candidate);
        return save ? save() : { reused: false, decision: { reason_code: 'THRESHOLD_MET' } };
      },
    },
  );
  return { cycle, calls };
}

test('cycle persists after selection in a short transaction and commits before reporting success', async () => {
  const { cycle, calls } = harness();
  assert.deepEqual(await cycle.tick(signal()), {
    kind: 'INSERTED',
    observation_id: scope.observation_id,
    reason_code: 'THRESHOLD_MET',
  });
  assert.deepEqual(calls, ['read', 'connect', 'BEGIN', 'save', 'COMMIT', 'release']);
});

test('replayed decisions return EXISTING while database failures release the busy guard', async () => {
  let saves = 0;
  const { cycle, calls } = harness({
    save() {
      if (++saves === 1) throw new Error('Database unavailable');
      return { reused: true, decision: { reason_code: 'INFERENCE_ERROR' } };
    },
  });
  await assert.rejects(cycle.tick(signal()), /Database unavailable/);
  assert.deepEqual(calls, ['read', 'connect', 'BEGIN', 'save', 'ROLLBACK', 'release']);
  assert.deepEqual(await cycle.tick(signal()), {
    kind: 'EXISTING',
    observation_id: scope.observation_id,
    reason_code: 'INFERENCE_ERROR',
  });
});

test('overlapping ticks are rejected and cancellation during selection prevents writes', async () => {
  let release;
  const controller = new AbortController();
  const { cycle, calls } = harness({
    read: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = cycle.tick(controller.signal);
  assert.equal((await cycle.tick(signal())).kind, 'BUSY');
  controller.abort();
  release(candidate);
  assert.equal((await pending).kind, 'CANCELLED');
  assert.deepEqual(calls, ['read']);
  assert.equal((await cycle.tick(controller.signal)).kind, 'CANCELLED');
});

test('cancellation while waiting for a connection skips the save and releases the connection', async () => {
  const controller = new AbortController();
  const { cycle, calls } = harness({ connect: async () => controller.abort() });
  assert.equal((await cycle.tick(controller.signal)).kind, 'CANCELLED');
  assert.deepEqual(calls, ['read', 'connect', 'BEGIN', 'COMMIT', 'release']);
});

test('empty and foreign candidates never open a write transaction', async () => {
  const idle = harness({ read: async () => null });
  assert.deepEqual(await idle.cycle.tick(signal()), { kind: 'IDLE' });
  assert.deepEqual(idle.calls, ['read']);
  const foreign = harness({ read: async () => ({ ...candidate, run_id: scope.channel_id }) });
  await assert.rejects(foreign.cycle.tick(signal()), /another run/);
  assert.deepEqual(foreign.calls, ['read']);
});
