const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { loadConfig } = source('packages/config/src/index.ts');
const { AutomaticAiCycle, createAutomaticAiCycle } = source(
  'apps/worker/src/ingestion/automatic-ai-cycle.ts',
);

const runId = 'a0000000-0000-4000-8000-000000000001';
const nextRun = 'b0000000-0000-4000-8000-000000000002';
const revision = 'a'.repeat(40);
const signal = () => new AbortController().signal;
const selected = (id = runId) => ({ kind: 'SELECTED', run_id: id });
const env = {
  DATABASE_URL: 'postgresql://demo:demo@127.0.0.1:55432/demo',
  WORKER_ENABLED: 'true',
  GOOGLE_AUTH_ENABLED: 'true',
  GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'local-test-only',
  TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  AI_AUTOMATIC_ENABLED: 'true',
  AI_SHADOW_MODEL_REVISION: revision,
};

function harness({ read, inference, decisions, plans, dispose, construct } = {}) {
  const events = [];
  const statuses = [];
  const builds = [];
  let reads = 0;
  let cycle;
  cycle = new AutomaticAiCycle(
    {
      async next(workSignal) {
        events.push('read');
        return read ? read(++reads, workSignal) : selected();
      },
    },
    (id) => {
      builds.push(id);
      if (construct) construct(id);
      return Object.fromEntries(
        Object.entries({ inference, decisions, plans }).map(([stage, callback]) => [
          stage,
          {
            async tick(workSignal) {
              events.push(stage);
              assert.equal(cycle.allowedRunId(), id);
              return callback ? callback(workSignal) : { kind: 'IDLE' };
            },
          },
        ]),
      );
    },
    {
      async dispose() {
        events.push('dispose');
        if (dispose) await dispose();
      },
    },
    (status) => statuses.push(status),
  );
  return { cycle, events, statuses, builds };
}

test('automatic configuration is opt-in, pins the model, and needs no run UUID', () => {
  const config = loadConfig(env);
  assert.equal(config.AI_AUTOMATIC_ENABLED, true);
  assert.equal(config.AI_SHADOW_ENABLED, false);
  assert.equal(config.AI_SHADOW_RUN_ID, '');
  assert.equal(loadConfig({ DATABASE_URL: env.DATABASE_URL }).AI_AUTOMATIC_ENABLED, false);
  for (const changed of [
    { AI_SHADOW_ENABLED: 'true' },
    { AI_SHADOW_RUN_ID: runId },
    { AI_SHADOW_MODEL_REVISION: '' },
    { AI_SHADOW_MODEL_REVISION: 'main' },
    { WORKER_ENABLED: 'false' },
    { GOOGLE_AUTH_ENABLED: 'false' },
    { AI_AUTOMATIC_ENABLED: 'yes' },
  ])
    assert.throws(() => loadConfig({ ...env, ...changed }));
});

test('disabled automatic mode constructs neither a runner nor database work', () => {
  const fail = () => assert.fail('Disabled mode must not initialize AI.');
  assert.equal(
    createAutomaticAiCycle({ AI_AUTOMATIC_ENABLED: false }, { query: fail }, fail),
    undefined,
  );
});

test('inference, audits, and plans run serially with discovery between every stage', async () => {
  const { cycle, events, statuses, builds } = harness();
  assert.equal(cycle.allowedRunId(), null);
  assert.deepEqual(await cycle.tick(signal()), { kind: 'PROCESSED', run_id: runId });
  assert.deepEqual(events, ['read', 'inference', 'read', 'decisions', 'read', 'plans', 'read']);
  await cycle.tick(signal());
  assert.deepEqual(builds, [runId]);
  assert.deepEqual(statuses, ['SELECTED']);
  assert.equal(cycle.allowedRunId(), runId);
  await cycle.dispose();
  assert.equal(cycle.allowedRunId(), null);
});

test('stop and a new eligible run change scope without restarting the coordinator', async () => {
  let current = selected();
  const { cycle, builds, statuses } = harness({ read: () => current });
  await cycle.tick(signal());
  current = { kind: 'IDLE' };
  assert.equal((await cycle.tick(signal())).kind, 'IDLE');
  assert.equal(cycle.allowedRunId(), null);
  current = selected(nextRun);
  assert.deepEqual(await cycle.tick(signal()), { kind: 'PROCESSED', run_id: nextRun });
  assert.equal(cycle.allowedRunId(), nextRun);
  assert.deepEqual(builds, [runId, nextRun]);
  assert.deepEqual(statuses, ['SELECTED', 'IDLE', 'SELECTED']);
  await cycle.dispose();
});

test('stop or capacity changes after inference prevent audit and materialization', async () => {
  for (const kind of ['IDLE', 'CAPACITY_EXCEEDED']) {
    const { cycle, events } = harness({ read: (reads) => (reads === 1 ? selected() : { kind }) });
    assert.equal((await cycle.tick(signal())).kind, 'SCOPE_CHANGED');
    assert.equal(cycle.allowedRunId(), null);
    assert.deepEqual(events, ['read', 'inference', 'read']);
    await cycle.dispose();
  }
});

test('run changes between stages do not mix an old inference with new-run plans', async () => {
  const { cycle, events, builds } = harness({
    read: (reads) => (reads === 1 ? selected() : selected(nextRun)),
  });
  assert.equal((await cycle.tick(signal())).kind, 'SCOPE_CHANGED');
  assert.equal(cycle.allowedRunId(), null);
  assert.ok(!events.includes('decisions'));
  assert.equal((await cycle.tick(signal())).run_id, nextRun);
  assert.deepEqual(builds, [runId, nextRun]);
  await cycle.dispose();
});

test('access loss after audit prevents plans and clears dispatch permission', async () => {
  const { cycle, events } = harness({
    read: (reads) => (reads < 3 ? selected() : { kind: 'IDLE' }),
  });
  await cycle.tick(signal());
  assert.deepEqual(events, ['read', 'inference', 'read', 'decisions', 'read']);
  assert.equal(cycle.allowedRunId(), null);
  await cycle.dispose();
});

test('stop during plan creation revokes dispatch at the final discovery check', async () => {
  const { cycle } = harness({
    read: (reads) => (reads < 4 ? selected() : { kind: 'IDLE' }),
  });
  assert.equal((await cycle.tick(signal())).kind, 'SCOPE_CHANGED');
  assert.equal(cycle.allowedRunId(), null);
  await cycle.dispose();
});

test('capacity pauses all AI stages and reports once until the state changes', async () => {
  const { cycle, events, statuses } = harness({ read: () => ({ kind: 'CAPACITY_EXCEEDED' }) });
  await cycle.tick(signal());
  await cycle.tick(signal());
  assert.equal(cycle.allowedRunId(), null);
  assert.deepEqual(events, ['read', 'read']);
  assert.deepEqual(statuses, ['CAPACITY_EXCEEDED']);
  await cycle.dispose();
});

test('discovery failure revokes a previous selection and a later tick recovers', async () => {
  let failed = false;
  const { cycle, statuses } = harness({
    read: () => {
      if (failed) throw new Error('Database unavailable');
      return selected();
    },
  });
  await cycle.tick(signal());
  failed = true;
  await assert.rejects(cycle.tick(signal()), /Database unavailable/);
  assert.equal(cycle.allowedRunId(), null);
  failed = false;
  await cycle.tick(signal());
  assert.equal(cycle.allowedRunId(), runId);
  assert.deepEqual(statuses, ['SELECTED', 'ERROR', 'SELECTED']);
  await cycle.dispose();
});

test('stage failures release busy state and do not leave dispatch permission enabled', async () => {
  for (const stage of ['inference', 'decisions', 'plans']) {
    let failed = true;
    const { cycle } = harness({
      [stage]: () => {
        if (failed) throw new Error('stage fixture');
      },
    });
    await assert.rejects(cycle.tick(signal()), /stage fixture/);
    assert.equal(cycle.allowedRunId(), null);
    failed = false;
    assert.equal((await cycle.tick(signal())).kind, 'PROCESSED');
    await cycle.dispose();
  }
});

test('overlapping ticks cannot schedule additional inference', async () => {
  let release;
  let started;
  const stageStarted = new Promise((resolve) => {
    started = resolve;
  });
  const { cycle, events } = harness({
    inference: () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = cycle.tick(signal());
  await stageStarted;
  assert.equal((await cycle.tick(signal())).kind, 'BUSY');
  assert.equal(events.filter((event) => event === 'inference').length, 1);
  release();
  await pending;
  await cycle.dispose();
});

test('cancellation after inference prevents subsequent writes', async () => {
  const controller = new AbortController();
  const { cycle, events } = harness({ inference: () => controller.abort() });
  await cycle.tick(controller.signal);
  assert.equal(cycle.allowedRunId(), null);
  assert.deepEqual(events, ['read', 'inference']);
  assert.equal((await cycle.tick(controller.signal)).kind, 'CANCELLED');
  await cycle.dispose();
});

test('disposal revokes dispatch immediately, disposes once, and drains database work', async () => {
  let release;
  let started;
  const stageStarted = new Promise((resolve) => {
    started = resolve;
  });
  const { cycle, events } = harness({
    plans: () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = cycle.tick(signal());
  await stageStarted;
  let disposed = false;
  const stopping = cycle.dispose().then(() => {
    disposed = true;
  });
  assert.equal(cycle.allowedRunId(), null);
  await Promise.resolve();
  assert.equal(disposed, false);
  release();
  await Promise.all([pending, stopping, cycle.dispose()]);
  assert.equal(events.filter((event) => event === 'dispose').length, 1);
  assert.equal((await cycle.tick(signal())).kind, 'CANCELLED');
});

test('factory shares one runner across runs, defers native work, and persists no idle results', async () => {
  const config = loadConfig(env);
  let run = null;
  let constructions = 0;
  let disposals = 0;
  const model = {
    model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
    model_revision: revision,
    model_variant: 'INT8',
    adapter_version: 'laskar-shadow-1',
  };
  const pool = {
    async query(sql, values) {
      if (sql.includes('LIMIT 2')) {
        assert.deepEqual(values, [JSON.stringify(model)]);
        return {
          rows: run
            ? [
                {
                  run_id: run,
                  channel_id: 'c0000000-0000-4000-8000-000000000003',
                  session_id: 'd0000000-0000-4000-8000-000000000004',
                  status: 'RUNNING',
                  stop_requested_at: null,
                  finished_at: null,
                  session_source: 'YOUTUBE',
                  closed_at: null,
                  chat_ended_at: null,
                  snapshot: {
                    source: 'SAVED',
                    run_id: run,
                    channel_id: 'c0000000-0000-4000-8000-000000000003',
                    settings_id: 'e0000000-0000-4000-8000-000000000005',
                    settings_revision: 1,
                    configuration: {
                      schema_version: 1,
                      automatic_actions_enabled: true,
                      model,
                      score_metric: 'EXPECTED_SEVERITY',
                      delete: { enabled: true, threshold: 0.5 },
                      timeout: { enabled: true, threshold: 0.7, duration_seconds: 30 },
                      ban: { enabled: false, threshold: 0.9 },
                    },
                  },
                },
              ]
            : [],
        };
      }
      assert.equal(values[0], run);
      return { rows: [] };
    },
    connect() {
      assert.fail('An empty chat backlog must not persist anything.');
    },
  };
  const cycle = createAutomaticAiCycle(
    config,
    pool,
    (options) => {
      constructions++;
      assert.equal(options.revision, revision);
      return {
        predict() {
          assert.fail('No messages require native inference.');
        },
        async dispose() {
          disposals++;
        },
      };
    },
    () => undefined,
  );
  assert.equal(constructions, 1);
  assert.equal((await cycle.tick(signal())).kind, 'IDLE');
  run = runId;
  assert.equal((await cycle.tick(signal())).run_id, runId);
  run = nextRun;
  assert.equal((await cycle.tick(signal())).run_id, nextRun);
  assert.equal(constructions, 1);
  assert.equal(disposals, 0);
  await cycle.dispose();
  assert.equal(disposals, 1);
});

test('pipeline construction failure cannot retain an earlier run permission', async () => {
  let current = runId;
  let failed = false;
  const { cycle } = harness({
    read: () => selected(current),
    construct: () => {
      if (failed) throw new Error('Pipeline unavailable');
    },
  });
  await cycle.tick(signal());
  current = nextRun;
  failed = true;
  await assert.rejects(cycle.tick(signal()), /Pipeline unavailable/);
  assert.equal(cycle.allowedRunId(), null);
  failed = false;
  assert.equal((await cycle.tick(signal())).run_id, nextRun);
  await cycle.dispose();
});

test('disposal during discovery never constructs cycles or re-enables dispatch', async () => {
  let release;
  const { cycle, builds } = harness({
    read: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = cycle.tick(signal());
  const stopping = cycle.dispose();
  assert.equal(cycle.allowedRunId(), null);
  release(selected());
  assert.equal((await pending).kind, 'CANCELLED');
  await stopping;
  assert.deepEqual(builds, []);
  assert.equal(cycle.allowedRunId(), null);
});

test('operational inference fault survives idle ticks until a successful result', async () => {
  let outcome = { status: 'ERROR', error_code: 'MODEL_UNAVAILABLE' };
  const { cycle } = harness({ inference: () => outcome });
  await cycle.tick(signal());
  assert.deepEqual(cycle.operationalState(), {
    selected_run_id: runId,
    fault: { run_id: runId, error_code: 'MODEL_UNAVAILABLE', source: 'INFERENCE' },
  });
  outcome = { kind: 'IDLE' };
  await cycle.tick(signal());
  assert.equal(cycle.operationalState().fault.error_code, 'MODEL_UNAVAILABLE');
  outcome = { status: 'ERROR', error_code: 'INPUT_TOO_LONG' };
  await cycle.tick(signal());
  assert.equal(cycle.operationalState().fault.error_code, 'MODEL_UNAVAILABLE');
  outcome = { status: 'ERROR', error_code: 'INPUT_EXPIRED' };
  await cycle.tick(signal());
  assert.equal(cycle.operationalState().fault.error_code, 'MODEL_UNAVAILABLE');
  outcome = { status: 'SUCCEEDED' };
  await cycle.tick(signal());
  assert.equal(cycle.operationalState().fault, null);
  await cycle.dispose();
});

test('pipeline faults are safe and clear after successful recovery without another message', async () => {
  let fail = true;
  const { cycle } = harness({
    decisions: () => {
      if (fail)
        throw Object.assign(new Error('private connection and credential details'), {
          code: 'ECONNRESET',
        });
      return { kind: 'IDLE' };
    },
  });
  await assert.rejects(cycle.tick(signal()));
  assert.deepEqual(cycle.operationalState(), {
    selected_run_id: null,
    fault: { run_id: runId, error_code: 'DATABASE_UNAVAILABLE', source: 'PIPELINE' },
  });
  const copy = cycle.operationalState();
  copy.fault.error_code = 'INFERENCE_FAILED';
  assert.equal(cycle.operationalState().fault.error_code, 'DATABASE_UNAVAILABLE');
  fail = false;
  await cycle.tick(signal());
  assert.equal(cycle.operationalState().fault, null);
  await cycle.dispose();
});
