const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { AiShadowCoordinator } = source('apps/worker/src/ingestion/ai-shadow-coordinator.ts');
const { AiShadowCandidateReader } = source(
  'apps/worker/src/ingestion/ai-shadow-candidate-reader.ts',
);
const { AiShadowResultWriter } = source('apps/worker/src/ingestion/ai-shadow-result-writer.ts');

const identity = {
  channel_id: '10000000-0000-4000-8000-000000000001',
  session_id: '20000000-0000-4000-8000-000000000002',
  observation_id: '30000000-0000-4000-8000-000000000003',
  run_id: '40000000-0000-4000-8000-000000000004',
  model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8',
  adapter_version: 'laskar-shadow-1',
};
const model = {
  model_id: identity.model_id,
  model_revision: identity.model_revision,
  model_variant: identity.model_variant,
  adapter_version: identity.adapter_version,
};
const success = {
  ...identity,
  status: 'SUCCEEDED',
  rating: 2,
  severity_score: 0.56,
  truncated: false,
  inference_ms: 5,
  error_code: null,
};
const terminalError = {
  ...identity,
  status: 'ERROR',
  rating: null,
  severity_score: null,
  truncated: null,
  inference_ms: null,
  error_code: 'INFERENCE_TIMEOUT',
};
const signal = () => new AbortController().signal;

function harness(overrides = {}) {
  const calls = [];
  const coordinator = new AiShadowCoordinator(
    {
      async next(runId) {
        calls.push('read');
        assert.equal(runId, identity.run_id);
        return overrides.candidate === undefined
          ? { identity, text: 'Hello fixture' }
          : overrides.candidate;
      },
    },
    {
      async predict(observation, text) {
        calls.push('infer');
        assert.deepEqual(observation, identity);
        assert.equal(text, 'Hello fixture');
        if (overrides.predict) return overrides.predict();
        return overrides.output ?? success;
      },
    },
    {
      async save(result) {
        calls.push('save');
        if (overrides.save) return overrides.save(result);
        return { id: identity.observation_id, result, inserted: true };
      },
    },
  );
  return { coordinator, calls };
}

test('one tick reads, infers, and persists a shadow result in order', async () => {
  const { coordinator, calls } = harness();
  assert.deepEqual(await coordinator.tick(identity.run_id, signal()), {
    kind: 'INSERTED',
    observation_id: identity.observation_id,
    status: 'SUCCEEDED',
  });
  assert.deepEqual(calls, ['read', 'infer', 'save']);
});

test('terminal inference errors are persisted without fabricating a safe rating', async () => {
  const { coordinator } = harness({
    output: terminalError,
    save: async (result) => {
      assert.deepEqual(result, terminalError);
      return { id: identity.observation_id, result, inserted: true };
    },
  });
  assert.equal((await coordinator.tick(identity.run_id, signal())).status, 'ERROR');
});

test('a competing committed result wins over new inference output', async () => {
  const { coordinator } = harness({
    save: async () => ({
      id: identity.observation_id,
      result: terminalError,
      inserted: false,
    }),
  });
  assert.deepEqual(await coordinator.tick(identity.run_id, signal()), {
    kind: 'EXISTING',
    observation_id: identity.observation_id,
    status: 'ERROR',
  });
});

test('an exhausted queue does not invoke inference or persistence', async () => {
  const { coordinator, calls } = harness({ candidate: null });
  assert.equal((await coordinator.tick(identity.run_id, signal())).kind, 'IDLE');
  assert.deepEqual(calls, ['read']);
});

test('busy inference is deferred and the next tick can try again', async () => {
  let attempts = 0;
  const { coordinator, calls } = harness({
    predict: async () => {
      if (++attempts === 1) throw new Error('AI_ADAPTER_BUSY');
      return success;
    },
  });
  assert.equal((await coordinator.tick(identity.run_id, signal())).kind, 'BUSY');
  assert.equal((await coordinator.tick(identity.run_id, signal())).kind, 'INSERTED');
  assert.deepEqual(calls, ['read', 'infer', 'read', 'infer', 'save']);
});

test('overlapping ticks do not start another inference; abort prevents the write', async () => {
  let release;
  const controller = new AbortController();
  const { coordinator, calls } = harness({
    predict: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = coordinator.tick(identity.run_id, controller.signal);
  await Promise.resolve();
  assert.equal((await coordinator.tick(identity.run_id, signal())).kind, 'BUSY');
  controller.abort();
  release(success);
  assert.equal((await pending).kind, 'CANCELLED');
  assert.deepEqual(calls, ['read', 'infer']);
  assert.equal((await coordinator.tick(identity.run_id, controller.signal)).kind, 'CANCELLED');
});

test('cancellation during candidate selection prevents inference', async () => {
  const controller = new AbortController();
  const coordinator = new AiShadowCoordinator(
    {
      async next() {
        controller.abort();
        return { identity, text: 'Hello' };
      },
    },
    {
      async predict() {
        assert.fail('Unexpected inference');
      },
    },
    {
      async save() {
        assert.fail('Unexpected persistence');
      },
    },
  );
  assert.equal((await coordinator.tick(identity.run_id, controller.signal)).kind, 'CANCELLED');
});

test('mismatched output and foreign-run candidates never reach persistence', async () => {
  for (const field of ['channel_id', 'session_id', 'observation_id', 'run_id', 'model_revision']) {
    const value =
      field === 'model_revision' ? 'b'.repeat(40) : '90000000-0000-4000-8000-000000000009';
    const { coordinator, calls } = harness({ output: { ...success, [field]: value } });
    await assert.rejects(coordinator.tick(identity.run_id, signal()), /another identity/);
    assert.deepEqual(calls, ['read', 'infer']);
  }
  const { coordinator, calls } = harness({
    candidate: {
      identity: { ...identity, run_id: '90000000-0000-4000-8000-000000000009' },
      text: 'Hello fixture',
    },
  });
  await assert.rejects(coordinator.tick(identity.run_id, signal()), /another run/);
  assert.deepEqual(calls, ['read']);
});

test('a database failure releases the busy guard for a later tick', async () => {
  let writes = 0;
  const { coordinator } = harness({
    save: async (result) => {
      if (++writes === 1) throw new Error('Database unavailable');
      return { id: identity.observation_id, result, inserted: true };
    },
  });
  await assert.rejects(coordinator.tick(identity.run_id, signal()), /Database unavailable/);
  assert.equal((await coordinator.tick(identity.run_id, signal())).kind, 'INSERTED');
});

test('candidate reader binds run and model identity and rejects invalid run IDs before querying', async () => {
  let queries = 0;
  const reader = new AiShadowCandidateReader(
    {
      async query(_sql, values) {
        queries++;
        assert.deepEqual(values, [identity.run_id, ...Object.values(model)]);
        return {
          rows: [
            {
              channel_id: identity.channel_id,
              session_id: identity.session_id,
              observation_id: identity.observation_id,
              run_id: identity.run_id,
              text: 'Hello fixture',
            },
          ],
        };
      },
    },
    model,
  );
  await assert.rejects(reader.next('invalid'));
  assert.equal(queries, 0);
  assert.deepEqual(await reader.next(identity.run_id), { identity, text: 'Hello fixture' });
});

test('writer commits or rolls back and always releases its connection', async () => {
  for (const fails of [false, true]) {
    const calls = [];
    const client = {
      async query(sql) {
        calls.push(sql);
      },
      release() {
        calls.push('release');
      },
    };
    const writer = new AiShadowResultWriter(
      {
        async connect() {
          calls.push('connect');
          return client;
        },
      },
      {
        async save(connection, result) {
          assert.equal(connection, client);
          assert.deepEqual(result, success);
          calls.push('save');
          if (fails) throw new Error('Write failed');
          return { id: identity.observation_id, result, inserted: true };
        },
      },
      async (connection, event) => {
        assert.equal(connection, client);
        assert.deepEqual(event, {
          channelId: identity.channel_id,
          sessionId: identity.session_id,
          runId: identity.run_id,
          type: 'chat.updated',
        });
        calls.push('publish');
        return { sequence: '1' };
      },
    );
    if (fails) await assert.rejects(writer.save(success), /Write failed/);
    else assert.equal((await writer.save(success)).inserted, true);
    assert.deepEqual(
      calls,
      fails
        ? ['connect', 'BEGIN', 'save', 'ROLLBACK', 'release']
        : ['connect', 'BEGIN', 'save', 'publish', 'COMMIT', 'release'],
    );
  }
});

test('writer does not publish an event for an existing result', async () => {
  const client = { async query() {}, release() {} };
  const writer = new AiShadowResultWriter(
    {
      async connect() {
        return client;
      },
    },
    {
      async save() {
        return { id: identity.observation_id, result: success, inserted: false };
      },
    },
    async () => {
      assert.fail('Unexpected duplicate publication');
    },
  );
  assert.equal((await writer.save(success)).inserted, false);
});

test('publication failure rolls back the result instead of committing an invisible update', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
    },
    release() {
      calls.push('release');
    },
  };
  const writer = new AiShadowResultWriter(
    {
      async connect() {
        return client;
      },
    },
    {
      async save() {
        return { id: identity.observation_id, result: success, inserted: true };
      },
    },
    async () => {
      throw new Error('Publication failed');
    },
  );
  await assert.rejects(writer.save(success), /Publication failed/);
  assert.deepEqual(calls, ['BEGIN', 'ROLLBACK', 'release']);
});
