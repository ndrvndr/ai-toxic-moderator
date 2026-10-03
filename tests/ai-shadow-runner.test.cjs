const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { source } = require('./helpers/source.cjs');
const { AiShadowRunner } = source('apps/worker/src/ingestion/ai-shadow-runner.ts');

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

test('native crash becomes an error and three consecutive failures stop restart attempts', async () => {
  let spawned = 0;
  const runner = new AiShadowRunner(options, () => {
    spawned++;
    return new FakeChild('crash');
  });
  try {
    for (let i = 0; i < 3; i++)
      assert.equal((await runner.predict(observation, 'hello')).error_code, 'INFERENCE_FAILED');
    assert.equal((await runner.predict(observation, 'fourth')).error_code, 'MODEL_UNAVAILABLE');
    assert.equal(spawned, 3);
  } finally {
    await runner.dispose();
  }
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
