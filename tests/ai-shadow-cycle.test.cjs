const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { loadConfig } = source('packages/config/src/index.ts');
const { AiShadowCycle, createAiShadowCycle } = source(
  'apps/worker/src/ingestion/ai-shadow-cycle.ts',
);

const env = { DATABASE_URL: 'postgresql://demo:demo@127.0.0.1:55432/demo' };
const runId = '40000000-0000-4000-8000-000000000004';
const revision = 'a'.repeat(40);
const enabledEnv = {
  ...env,
  WORKER_ENABLED: 'true',
  AI_SHADOW_ENABLED: 'true',
  AI_SHADOW_RUN_ID: runId,
  AI_SHADOW_MODEL_REVISION: revision,
};

test('shadow is disabled by default and does not construct inference or access the database', () => {
  const config = loadConfig(env);
  assert.equal(config.AI_SHADOW_ENABLED, false);
  assert.equal(
    createAiShadowCycle(
      config,
      {
        query() {
          assert.fail('Unexpected database query');
        },
        connect() {
          assert.fail('Unexpected connection');
        },
      },
      () => {
        assert.fail('Unexpected runner construction');
      },
    ),
    undefined,
  );
});

test('enabled shadow requires explicit worker, run, revision, and bounded deadlines', () => {
  assert.equal(loadConfig(enabledEnv).AI_SHADOW_ENABLED, true);
  for (const overrides of [
    { WORKER_ENABLED: 'false' },
    { AI_SHADOW_RUN_ID: '' },
    { AI_SHADOW_RUN_ID: 'invalid' },
    { AI_SHADOW_MODEL_REVISION: '' },
    { AI_SHADOW_MODEL_REVISION: 'main' },
    { AI_SHADOW_STARTUP_TIMEOUT_MS: '0' },
    { AI_SHADOW_INFERENCE_TIMEOUT_MS: '300001' },
    { AI_SHADOW_INFERENCE_TIMEOUT_MS: 'NaN' },
    { AI_SHADOW_CACHE_DIRECTORY: '' },
    { AI_SHADOW_ENABLED: 'yes' },
  ])
    assert.throws(() => loadConfig({ ...enabledEnv, ...overrides }));
});

test('cycle scopes selection and persists terminal output using the configured runner', async () => {
  const config = loadConfig({
    ...enabledEnv,
    AI_SHADOW_CACHE_DIRECTORY: '.cache/local-fixture',
    AI_SHADOW_STARTUP_TIMEOUT_MS: '20000',
    AI_SHADOW_INFERENCE_TIMEOUT_MS: '3000',
  });
  const calls = [];
  const row = {
    channel_id: '10000000-0000-4000-8000-000000000001',
    session_id: '20000000-0000-4000-8000-000000000002',
    observation_id: '30000000-0000-4000-8000-000000000003',
    run_id: runId,
    text: 'Hello fixture',
    snapshot: {
      run_id: runId,
      channel_id: '10000000-0000-4000-8000-000000000001',
      blacklist_id: null,
      blacklist_revision: null,
      source: 'DEFAULT',
      configuration: { schema_version: 1, enabled: false, rules: [] },
    },
  };
  let output;
  let persisted = false;
  const pool = {
    async query(_sql, values) {
      calls.push('read');
      assert.deepEqual(values, [
        runId,
        'laskar-ks/toxic-guardrail-minilm-id-en',
        revision,
        'INT8',
        'laskar-shadow-1',
        null,
        null,
      ]);
      return { rows: persisted ? [] : [row] };
    },
    async connect() {
      calls.push('connect');
      return {
        async query(sql) {
          if (sql.includes('INSERT INTO youtube_ai_shadow_results')) {
            calls.push('insert');
            persisted = true;
            return { rows: [{ id: row.observation_id, ...output }] };
          }
          if (sql.includes('INSERT INTO live_event_counters')) {
            calls.push('counter-create');
            return { rows: [] };
          }
          if (sql.includes('UPDATE live_event_counters')) {
            calls.push('counter-update');
            return { rows: [{ sequence: '1' }] };
          }
          if (sql.includes('INSERT INTO live_events')) {
            calls.push('event-insert');
            return { rows: [] };
          }
          calls.push(sql);
          return { rows: [] };
        },
        release() {
          calls.push('release');
        },
      };
    },
  };
  let disposals = 0;
  const cycle = createAiShadowCycle(config, pool, (options) => {
    assert.deepEqual(options, {
      cacheDirectory: '.cache/local-fixture',
      revision,
      startupMs: 20000,
      inferenceMs: 3000,
    });
    return {
      async predict(identity, text) {
        calls.push('infer');
        assert.equal(text, 'Hello fixture');
        output = {
          ...identity,
          status: 'ERROR',
          rating: null,
          severity_score: null,
          truncated: null,
          inference_ms: null,
          error_code: 'MODEL_UNAVAILABLE',
        };
        return output;
      },
      async dispose() {
        disposals++;
      },
    };
  });
  const signal = new AbortController().signal;
  assert.equal((await cycle.tick(signal)).kind, 'INSERTED');
  assert.deepEqual(calls, [
    'read',
    'infer',
    'connect',
    'BEGIN',
    'insert',
    'counter-create',
    'counter-update',
    'event-insert',
    'COMMIT',
    'release',
  ]);
  assert.equal((await cycle.tick(signal)).kind, 'IDLE');
  await cycle.dispose();
  await cycle.dispose();
  assert.equal(disposals, 1);
  assert.equal((await cycle.tick(signal)).kind, 'CANCELLED');
});

test('cycle cancellation prevents scheduling and disposal remains idempotent', async () => {
  let ticks = 0;
  let disposals = 0;
  const controller = new AbortController();
  const cycle = new AiShadowCycle(
    runId,
    {
      async tick(selectedRun, signal) {
        ticks++;
        assert.equal(selectedRun, runId);
        assert.equal(signal, controller.signal);
        return { kind: 'IDLE' };
      },
    },
    {
      async dispose() {
        disposals++;
      },
    },
  );
  await cycle.tick(controller.signal);
  controller.abort();
  assert.equal((await cycle.tick(controller.signal)).kind, 'CANCELLED');
  await Promise.all([cycle.dispose(), cycle.dispose()]);
  assert.equal(ticks, 1);
  assert.equal(disposals, 1);
});
