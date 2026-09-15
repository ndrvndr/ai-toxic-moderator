const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { WorkerRuntime } = source('apps/worker/src/ingestion/worker-runtime.ts');

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
