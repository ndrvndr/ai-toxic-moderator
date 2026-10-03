const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { WorkerRuntime } = source('apps/worker/src/ingestion/worker-runtime.ts');

test('shadow runs independently and shutdown disposes inference before closing the pool', async () => {
  const events = [];
  let release;
  let shadowSignal;
  const runtime = new WorkerRuntime(
    {
      async tick(signal) {
        events.push('ingestion-started');
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        events.push('ingestion-finished');
      },
    },
    {
      async end() {
        events.push('pool-closed');
      },
    },
    undefined,
    undefined,
    undefined,
    {
      async tick(signal) {
        shadowSignal = signal;
        events.push('shadow-started');
        await new Promise((resolve) => {
          release = resolve;
        });
        assert.equal(signal.aborted, true);
        events.push('shadow-finished');
      },
      async dispose() {
        events.push('shadow-disposed');
        release();
      },
    },
  );
  runtime.start();
  assert.deepEqual(events, ['ingestion-started', 'shadow-started']);
  const stopping = runtime.onApplicationShutdown();
  assert.equal(shadowSignal.aborted, true);
  await stopping;
  await runtime.onApplicationShutdown();
  assert.equal(events.filter((event) => event === 'shadow-disposed').length, 1);
  assert.equal(events.at(-1), 'pool-closed');
  assert.ok(events.indexOf('shadow-disposed') < events.indexOf('shadow-finished'));
});

test('shutdown drains an in-progress shadow database write even after inference disposal', async () => {
  let release;
  let disposed = false;
  let closed = false;
  const runtime = new WorkerRuntime(
    { async tick() {} },
    {
      async end() {
        closed = true;
      },
    },
    undefined,
    undefined,
    undefined,
    {
      async tick() {
        await new Promise((resolve) => {
          release = resolve;
        });
      },
      async dispose() {
        disposed = true;
      },
    },
  );
  runtime.start();
  const stopping = runtime.onApplicationShutdown();
  await Promise.resolve();
  assert.equal(disposed, true);
  assert.equal(closed, false);
  release();
  await stopping;
  assert.equal(closed, true);
});

test('shutdown disposes an unused shadow runner without starting it', async () => {
  let disposed = 0;
  const runtime = new WorkerRuntime(
    {
      async tick() {
        assert.fail('Unexpected ingestion');
      },
    },
    { async end() {} },
    undefined,
    undefined,
    undefined,
    {
      async tick() {
        assert.fail('Unexpected inference');
      },
      async dispose() {
        disposed++;
      },
    },
  );
  await runtime.onApplicationShutdown();
  runtime.start();
  assert.equal(disposed, 1);
});

test('shadow cycle failures do not interrupt ingestion or expose raw errors', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (message) => logs.push(message));
  let ingestionFinished = false;
  let disposed = false;
  const runtime = new WorkerRuntime(
    {
      async tick(signal) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        ingestionFinished = true;
      },
    },
    { async end() {} },
    undefined,
    undefined,
    undefined,
    {
      async tick() {
        throw new Error('private-error-fixture');
      },
      async dispose() {
        disposed = true;
      },
    },
  );
  runtime.start();
  await Promise.resolve();
  assert.equal(ingestionFinished, false);
  assert.ok(logs.some((message) => message.startsWith('AI shadow cycle failed.')));
  assert.ok(logs.every((message) => !message.includes('private-error-fixture')));
  await runtime.onApplicationShutdown();
  assert.equal(ingestionFinished, true);
  assert.equal(disposed, true);
});

test('recovery runs without deletion dispatch and shutdown waits for its database update', async () => {
  let release;
  let recoverySignal;
  let closed = false;
  const runtime = new WorkerRuntime(
    {
      async tick() {
        return { kind: 'IDLE' };
      },
    },
    {
      async end() {
        closed = true;
      },
    },
    undefined,
    {
      async tick(signal) {
        recoverySignal = signal;
        await new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  );
  runtime.start();
  assert.ok(recoverySignal);
  const stopped = runtime.onApplicationShutdown();
  assert.equal(recoverySignal.aborted, true);
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await stopped;
  assert.equal(closed, true);
});

test('ingestion and deletion run independently and both drain before the pool closes', async () => {
  const events = [];
  const cycle = (name) => ({
    async tick(signal) {
      events.push(`${name}-started`);
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      events.push(`${name}-finished`);
    },
  });
  const runtime = new WorkerRuntime(
    cycle('ingestion'),
    {
      async end() {
        events.push('pool-closed');
      },
    },
    cycle('deletion'),
  );
  runtime.start();
  assert.deepEqual(events, ['ingestion-started', 'deletion-started']);
  await runtime.onApplicationShutdown();
  assert.equal(events.at(-1), 'pool-closed');
  assert.ok(events.includes('ingestion-finished'));
  assert.ok(events.includes('deletion-finished'));
});

test('shutdown cancels the current cycle before closing the pool', async () => {
  const events = [];

  const runtime = new WorkerRuntime(
    {
      async tick(signal) {
        events.push('cycle-started');

        await new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              events.push('cycle-cancelled');
              resolve();
            },
            { once: true },
          );
        });

        events.push('cycle-finished');
        return { kind: 'CANCELLED' };
      },
    },
    {
      async end() {
        events.push('pool-closed');
      },
    },
  );

  runtime.start();
  runtime.start();

  await runtime.onApplicationShutdown();
  await runtime.onApplicationShutdown();

  assert.deepEqual(events, ['cycle-started', 'cycle-cancelled', 'cycle-finished', 'pool-closed']);
});

test('a stopped runtime cannot restart', async () => {
  let calls = 0;
  let closures = 0;

  const runtime = new WorkerRuntime(
    {
      async tick() {
        calls++;
        return { kind: 'IDLE' };
      },
    },
    {
      async end() {
        closures++;
      },
    },
  );

  await runtime.onApplicationShutdown();
  runtime.start();

  assert.equal(calls, 0);
  assert.equal(closures, 1);
});

test('shutdown drains evidence persistence before closing the pool', async () => {
  let release;
  let evidenceSignal;
  let closed = false;

  const runtime = new WorkerRuntime(
    {
      async tick() {
        return { kind: 'IDLE' };
      },
    },
    {
      async end() {
        closed = true;
      },
    },
    undefined,
    undefined,
    {
      recovery: {
        async tick() {},
      },
      evidence: {
        async tick(signal) {
          evidenceSignal = signal;

          await new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    },
  );

  runtime.start();

  assert.ok(evidenceSignal);

  const stopping = runtime.onApplicationShutdown();

  assert.equal(evidenceSignal.aborted, true);
  await Promise.resolve();
  assert.equal(closed, false);

  release();
  await stopping;

  assert.equal(closed, true);
});
