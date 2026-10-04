const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { AiOperationalStatusReader } = source(
  'apps/worker/src/ingestion/ai-operational-status-reader.ts',
);
const { AiOperationalStatusCoordinator } = source(
  'apps/worker/src/ingestion/ai-operational-status-coordinator.ts',
);
const { operationalErrorCode, inferenceErrorCode } = source(
  'apps/worker/src/ingestion/ai-operational-fault.ts',
);

const channel = '10000000-0000-4000-8000-000000000001';
const run = '20000000-0000-4000-8000-000000000002';
const session = '30000000-0000-4000-8000-000000000003';
const other = '40000000-0000-4000-8000-000000000004';
const model = {
  model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8',
  adapter_version: 'laskar-shadow-1',
};
const signal = () => new AbortController().signal;
const candidate = () => ({
  channel_id: channel,
  run_id: run,
  session_id: session,
  status: 'RUNNING',
  model_status: null,
  model_error_code: null,
  stop_requested_at: null,
  finished_at: null,
  session_source: 'YOUTUBE',
  closed_at: null,
  chat_ended_at: null,
  snapshot: {
    source: 'SAVED',
    run_id: run,
    channel_id: channel,
    settings_id: other,
    settings_revision: 1,
    configuration: {
      schema_version: 1,
      automatic_actions_enabled: true,
      model: { ...model },
      score_metric: 'EXPECTED_SEVERITY',
      delete: { enabled: true, threshold: 0.4 },
      timeout: { enabled: true, threshold: 0.6, duration_seconds: 30 },
      ban: { enabled: false, threshold: 0.9 },
    },
  },
});
const active = {
  channel_id: channel,
  session_id: session,
  run_id: run,
  status: 'ACTIVE',
  reason: 'RUN_SELECTED',
  error_code: null,
};

test('diagnostic reader distinguishes disabled, mismatch, waiting and eligible snapshots', async () => {
  let row = candidate();
  const reader = new AiOperationalStatusReader(
    {
      async query() {
        return { rows: [row] };
      },
    },
    true,
    model,
  );
  assert.deepEqual(await reader.scan(signal()), [active]);
  row.snapshot.configuration.automatic_actions_enabled = false;
  assert.equal((await reader.scan(signal()))[0].reason, 'RUN_AI_DISABLED');
  row = candidate();
  row.snapshot.configuration.model.model_revision = 'b'.repeat(40);
  assert.equal((await reader.scan(signal()))[0].status, 'MODEL_MISMATCH');
  row = candidate();
  row.snapshot = {
    source: 'LEGACY',
    run_id: run,
    channel_id: channel,
    settings_id: null,
    settings_revision: null,
    configuration: null,
  };
  assert.equal((await reader.scan(signal()))[0].status, 'DISABLED');
  row = { channel_id: channel, run_id: null };
  assert.equal((await reader.scan(signal()))[0].status, 'WAITING');
  const disabled = new AiOperationalStatusReader(
    {
      async query() {
        return { rows: [{ channel_id: channel }] };
      },
    },
    false,
  );
  assert.equal((await disabled.scan(signal()))[0].reason, 'WORKER_AI_DISABLED');
});

test('reader marks affected channels at capacity without leaking competing run identifiers', async () => {
  const first = candidate(),
    second = candidate();
  second.channel_id = other;
  second.run_id = other;
  second.snapshot.channel_id = other;
  second.snapshot.run_id = other;
  const reader = new AiOperationalStatusReader(
    {
      async query() {
        return { rows: [first, second] };
      },
    },
    true,
    model,
  );
  const reports = await reader.scan(signal());
  assert.equal(reports.length, 2);
  assert.ok(
    reports.every(
      (r) => r.status === 'CAPACITY_EXCEEDED' && r.run_id === null && r.session_id === null,
    ),
  );
});

test('reader rejects stale lifecycle and foreign snapshots and honors cancellation', async () => {
  let row = candidate(),
    reads = 0;
  const reader = new AiOperationalStatusReader(
    {
      async query() {
        reads++;
        return { rows: [row] };
      },
    },
    true,
    model,
  );
  for (const change of [
    { status: 'STOPPED' },
    { stop_requested_at: 'now' },
    { finished_at: 'now' },
    { closed_at: 'now' },
    { chat_ended_at: 'now' },
    { session_source: 'SYNTHETIC' },
  ]) {
    row = { ...candidate(), ...change };
    await assert.rejects(reader.scan(signal()));
  }
  row = candidate();
  row.snapshot.channel_id = other;
  await assert.rejects(reader.scan(signal()), /scope mismatch/);
  const abort = new AbortController();
  abort.abort();
  const before = reads;
  assert.deepEqual(await reader.scan(abort.signal), []);
  assert.equal(reads, before);
});

function harness() {
  const h = {
    now: 0,
    reports: [],
    claims: 0,
    scanError: null,
    publishError: null,
    lost: false,
    states: [active],
    pipeline: { selected_run_id: run, fault: null },
  };
  h.coordinator = new AiOperationalStatusCoordinator(
    {
      async scan() {
        if (h.scanError) throw h.scanError;
        return h.states;
      },
    },
    {
      async claim(id) {
        h.claims++;
        return { channel_id: id, owner_id: other, generation: String(h.claims) };
      },
      async publish(lease, update) {
        if (h.publishError) throw h.publishError;
        if (h.lost) return null;
        h.reports.push(update);
        return update;
      },
    },
    () => h.pipeline,
    () => h.now,
  );
  return h;
}

test('status changes publish immediately while unchanged heartbeats are throttled to 10 seconds', async () => {
  const h = harness();
  await h.coordinator.tick(signal());
  assert.equal(h.reports.length, 1);
  h.now = 9999;
  await h.coordinator.tick(signal());
  assert.equal(h.reports.length, 1);
  h.now = 10000;
  await h.coordinator.tick(signal());
  assert.equal(h.reports.length, 2);
  h.pipeline.fault = { run_id: run, error_code: 'MODEL_UNAVAILABLE', source: 'INFERENCE' };
  await h.coordinator.tick(signal());
  assert.equal(h.reports.at(-1).status, 'ERROR');
  h.pipeline.fault = null;
  await h.coordinator.tick(signal());
  assert.equal(h.reports.at(-1).status, 'ACTIVE');
  assert.equal(h.claims, 1);
});

test('eligible diagnostic candidates cannot claim ACTIVE until the pipeline has selected them', async () => {
  const h = harness();
  h.pipeline.selected_run_id = null;
  await h.coordinator.tick(signal());
  assert.equal(h.reports.at(-1).status, 'WAITING');
  h.pipeline.fault = { run_id: null, error_code: 'PIPELINE_FAILED', source: 'PIPELINE' };
  await h.coordinator.tick(signal());
  assert.equal(h.reports.at(-1).status, 'ERROR');
  h.states = [{ ...active, status: 'MODEL_MISMATCH', reason: 'CAPTURED_MODEL_MISMATCH' }];
  await h.coordinator.tick(signal());
  assert.equal(h.reports.at(-1).status, 'MODEL_MISMATCH');
});

test('lost claims are reacquired and competing live owners are retried at bounded cadence', async () => {
  const h = harness();
  await h.coordinator.tick(signal());
  h.lost = true;
  h.now = 10000;
  await h.coordinator.tick(signal());
  h.lost = false;
  h.now = 10001;
  await h.coordinator.tick(signal());
  assert.equal(h.claims, 2);
  let attempts = 0;
  const blocked = new AiOperationalStatusCoordinator(
    {
      async scan() {
        return [active];
      },
    },
    {
      async claim() {
        attempts++;
        return null;
      },
      async publish() {
        assert.fail();
      },
    },
    () => h.pipeline,
    () => h.now,
  );
  await blocked.tick(signal());
  await blocked.tick(signal());
  assert.equal(attempts, 1);
  h.now += 10000;
  await blocked.tick(signal());
  assert.equal(attempts, 2);
});

test('reader errors publish safe failure when possible and normal reports recover afterward', async () => {
  const h = harness();
  await h.coordinator.tick(signal());
  h.scanError = Object.assign(new Error('private credentials'), { code: 'ECONNRESET' });
  await assert.rejects(h.coordinator.tick(signal()));
  assert.equal(h.reports.at(-1).error_code, 'DATABASE_UNAVAILABLE');
  assert.ok(!JSON.stringify(h.reports).includes('private'));
  h.scanError = null;
  await h.coordinator.tick(signal());
  assert.equal(h.reports.at(-1).status, 'ACTIVE');
  h.publishError = new Error('private database failure');
  h.now += 10000;
  await assert.rejects(h.coordinator.tick(signal()));
  h.publishError = null;
  await h.coordinator.tick(signal());
  assert.equal(h.reports.at(-1).status, 'ACTIVE');
});

test('cancellation and overlapping ticks never create a reporting queue', async () => {
  const h = harness(),
    abort = new AbortController();
  abort.abort();
  await h.coordinator.tick(abort.signal);
  assert.equal(h.claims, 0);
  let release,
    scans = 0;
  const c = new AiOperationalStatusCoordinator(
    {
      scan() {
        scans++;
        return new Promise((r) => {
          release = r;
        });
      },
    },
    {
      async claim() {
        assert.fail();
      },
      async publish() {
        assert.fail();
      },
    },
    () => h.pipeline,
  );
  const workAbort = new AbortController(),
    pending = c.tick(workAbort.signal);
  await c.tick(signal());
  assert.equal(scans, 1);
  workAbort.abort();
  release([active]);
  await pending;
});

test('safe fault mapping does not treat input length as model failure or leak exception text', () => {
  assert.equal(operationalErrorCode({ code: '57P01', message: 'private' }), 'DATABASE_UNAVAILABLE');
  assert.equal(operationalErrorCode(new Error('private')), 'PIPELINE_FAILED');
  assert.equal(inferenceErrorCode({ status: 'ERROR', error_code: 'INPUT_TOO_LONG' }), null);
  assert.equal(
    inferenceErrorCode({ status: 'ERROR', error_code: 'INFERENCE_TIMEOUT' }),
    'INFERENCE_TIMEOUT',
  );
  assert.equal(
    inferenceErrorCode({ status: 'ERROR', error_code: 'private raw error' }),
    'INFERENCE_FAILED',
  );
});
