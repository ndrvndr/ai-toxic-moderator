const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { source } = require('./helpers/source.cjs');
const { AiShadowRunner } = source('apps/worker/src/ingestion/ai-shadow-runner.ts');
const { AiShadowCoordinator } = source('apps/worker/src/ingestion/ai-shadow-coordinator.ts');

const observation = {
  channel_id: '10000000-0000-4000-8000-000000000001',
  session_id: '20000000-0000-4000-8000-000000000002',
  observation_id: '30000000-0000-4000-8000-000000000003',
  run_id: '40000000-0000-4000-8000-000000000004',
};
const options = {
  cacheDirectory: '.cache/ai-prototype',
  revision: 'a'.repeat(40),
  startupMs: 100,
  inferenceMs: 30,
};

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  kills = 0;
  requests = [];
  constructor(mode = 'success') {
    super();
    this.mode = mode;
  }
  send(payload, callback) {
    this.requests.push(payload);
    callback?.(null);
    queueMicrotask(() => {
      if (payload.type === 'init') {
        if (this.mode !== 'startup-hang')
          this.emit('message', { type: 'ready', revision: payload.revision });
      } else if (this.mode === 'crash') {
        this.signalCode = 'SIGSEGV';
        this.emit('exit', null, 'SIGSEGV');
      } else if (this.mode !== 'hang') {
        this.emit('message', {
          type: 'result',
          request_id: payload.request_id,
          result: {
            ...payload.identity,
            status: 'SUCCEEDED',
            rating: 2,
            severity_score: 0.56,
            truncated: false,
            inference_ms: 5,
            error_code: null,
            ...(this.mode === 'wrong-identity' ? { session_id: observation.channel_id } : {}),
          },
        });
      }
    });
  }
  kill() {
    this.kills++;
    this.signalCode = 'SIGKILL';
    this.emit('exit', null, 'SIGKILL');
    return true;
  }
}

test('one ready child serves subsequent requests and disposal stops it once', async () => {
  const children = [];
  const runner = new AiShadowRunner(options, () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  try {
    assert.equal((await runner.predict(observation, 'hello')).status, 'SUCCEEDED');
    assert.equal((await runner.predict(observation, 'next')).status, 'SUCCEEDED');
    assert.equal(children.length, 1);
    assert.equal(children[0].requests.filter((entry) => entry.type === 'init').length, 1);
  } finally {
    await runner.dispose();
  }
  await runner.dispose();
  assert.equal(children[0].kills, 1);
  assert.equal((await runner.predict(observation, 'closed')).error_code, 'MODEL_UNAVAILABLE');
});

test('timeout kills the child, rejects late output, and restarts only for a new request', async () => {
  const children = [];
  const runner = new AiShadowRunner(options, () => {
    const child = new FakeChild(children.length ? 'success' : 'hang');
    children.push(child);
    return child;
  });
  try {
    const result = await runner.predict(observation, 'first');
    assert.equal(result.error_code, 'INFERENCE_TIMEOUT');
    assert.equal(result.rating, null);
    assert.equal(children[0].kills, 1);
    assert.equal(children.length, 1);
    children[0].emit('message', {
      type: 'result',
      request_id: children[0].requests.at(-1).request_id,
      result: {},
    });
    assert.equal((await runner.predict(observation, 'second')).status, 'SUCCEEDED');
    assert.equal(children.length, 2);
    assert.equal(children[0].requests.filter((entry) => entry.type === 'predict').length, 1);
  } finally {
    await runner.dispose();
  }
});

test('native crashes open a cooldown and a failed recovery probe starts another cooldown', async () => {
  let spawned = 0;
  let now = 0;
  const runner = new AiShadowRunner(
    options,
    () => {
      spawned++;
      return new FakeChild('crash');
    },
    () => now,
  );
  try {
    for (let i = 0; i < 3; i++)
      assert.equal((await runner.predict(observation, 'hello')).error_code, 'INFERENCE_FAILED');
    await assert.rejects(runner.predict(observation, 'fourth'), /AI_ADAPTER_BUSY/);
    assert.equal(spawned, 3);
    now = 29_999;
    await assert.rejects(runner.predict(observation, 'still waiting'), /AI_ADAPTER_BUSY/);
    now = 30_000;
    assert.equal((await runner.predict(observation, 'probe')).error_code, 'INFERENCE_FAILED');
    assert.equal(spawned, 4);
    now = 59_999;
    await assert.rejects(runner.predict(observation, 'wait again'), /AI_ADAPTER_BUSY/);
    assert.equal(spawned, 4);
    now = 60_000;
    assert.equal((await runner.predict(observation, 'next probe')).error_code, 'INFERENCE_FAILED');
    assert.equal(spawned, 5);
  } finally {
    await runner.dispose();
  }
});

test('one successful recovery probe resets the circuit and reuses its child', async () => {
  const children = [];
  let now = 0;
  const runner = new AiShadowRunner(
    options,
    () => {
      const child = new FakeChild(children.length < 3 ? 'crash' : 'success');
      children.push(child);
      return child;
    },
    () => now,
  );
  try {
    for (let i = 0; i < 3; i++) await runner.predict(observation, 'crash');
    now = 30_000;
    const probe = runner.predict(observation, 'recovery');
    await assert.rejects(runner.predict(observation, 'overlapping probe'), /AI_ADAPTER_BUSY/);
    assert.equal((await probe).status, 'SUCCEEDED');
    assert.equal((await runner.predict(observation, 'normal work')).status, 'SUCCEEDED');
    assert.equal(children.length, 4);
    assert.equal(children[3].requests.filter((request) => request.type === 'predict').length, 2);
  } finally {
    await runner.dispose();
  }
});

test('disposal during cooldown prevents a recovery process from starting', async () => {
  let spawned = 0;
  let now = 0;
  const runner = new AiShadowRunner(
    options,
    () => {
      spawned++;
      return new FakeChild('crash');
    },
    () => now,
  );
  for (let i = 0; i < 3; i++) await runner.predict(observation, 'crash');
  await runner.dispose();
  now = 30_000;
  assert.equal(
    (await runner.predict(observation, 'after shutdown')).error_code,
    'MODEL_UNAVAILABLE',
  );
  assert.equal(spawned, 3);
});

test('startup deadline returns model unavailable without sending a prediction', async () => {
  const child = new FakeChild('startup-hang');
  const runner = new AiShadowRunner({ ...options, startupMs: 20 }, () => child);
  try {
    assert.equal((await runner.predict(observation, 'hello')).error_code, 'MODEL_UNAVAILABLE');
    assert.equal(child.requests.length, 1);
    assert.equal(child.kills, 1);
  } finally {
    await runner.dispose();
  }
});

test('a result for another session cannot be accepted', async () => {
  const child = new FakeChild('wrong-identity');
  const runner = new AiShadowRunner(options, () => child);
  try {
    assert.equal((await runner.predict(observation, 'hello')).error_code, 'INVALID_OUTPUT');
    assert.equal(child.kills, 1);
  } finally {
    await runner.dispose();
  }
});

test('busy backpressure and cleanup prevent overlapping or orphaned requests', async () => {
  const child = new FakeChild('hang');
  const runner = new AiShadowRunner(options, () => child);
  const active = runner.predict(observation, 'hello');
  await assert.rejects(runner.predict(observation, 'overlap'), /AI_ADAPTER_BUSY/);
  // Let the ready handshake finish before closing an active prediction.
  await new Promise((resolve) => setImmediate(resolve));
  await runner.dispose();
  assert.equal((await active).status, 'ERROR');
  assert.equal(child.listenerCount('message'), 0);
  assert.equal(child.kills, 1);
});

test('oversized input does not create an inference process', async () => {
  const runner = new AiShadowRunner(options, () => {
    throw new Error('must not spawn');
  });
  assert.equal((await runner.predict(observation, 'x'.repeat(10001))).error_code, 'INPUT_TOO_LONG');
  await runner.dispose();
});

test('cooldown defers a coordinator candidate without saving an error and later saves its probe', async () => {
  let now = 0;
  let spawned = 0;
  const saved = [];
  const runner = new AiShadowRunner(
    options,
    () => new FakeChild(spawned++ < 3 ? 'crash' : 'success'),
    () => now,
  );
  const signal = new AbortController().signal;
  const coordinator = new AiShadowCoordinator(
    {
      async next() {
        return {
          identity: runner.identity({
            ...observation,
            observation_id: `30000000-0000-4000-8000-${String(saved.length + 1).padStart(12, '0')}`,
          }),
          text: 'hello',
        };
      },
    },
    runner,
    {
      async save(result) {
        saved.push(result);
        return { inserted: true, result };
      },
    },
  );
  try {
    for (let i = 0; i < 3; i++)
      assert.equal((await coordinator.tick(observation.run_id, signal)).status, 'ERROR');
    for (let i = 0; i < 5; i++)
      assert.equal((await coordinator.tick(observation.run_id, signal)).kind, 'BUSY');
    assert.equal(saved.length, 3);
    assert.equal(spawned, 3);
    now = 30_000;
    assert.equal((await coordinator.tick(observation.run_id, signal)).status, 'SUCCEEDED');
    assert.equal(saved.length, 4);
    assert.equal(saved[3].observation_id, '30000000-0000-4000-8000-000000000004');
    assert.equal(
      saved.slice(0, 3).every((result) => result.status === 'ERROR'),
      true,
    );
  } finally {
    await runner.dispose();
  }
});

test('failure to terminate a child permanently blocks replacement despite elapsed cooldown', async () => {
  let now = 0;
  let spawned = 0;
  const child = new FakeChild('hang');
  child.kill = () => {
    throw new Error('cannot terminate');
  };
  const runner = new AiShadowRunner(
    options,
    () => {
      spawned++;
      return child;
    },
    () => now,
  );
  try {
    assert.equal((await runner.predict(observation, 'hang')).error_code, 'INFERENCE_TIMEOUT');
    now = 300_000;
    assert.equal(
      (await runner.predict(observation, 'replacement')).error_code,
      'MODEL_UNAVAILABLE',
    );
    assert.equal(spawned, 1);
  } finally {
    await runner.dispose();
  }
});
