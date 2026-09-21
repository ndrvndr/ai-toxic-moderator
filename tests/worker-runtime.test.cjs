const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { WorkerRuntime } = source('apps/worker/src/ingestion/worker-runtime.ts');

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
