const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { BanCoordinator } = source('apps/worker/src/ingestion/ban-coordinator.ts');
const { BanRecovery } = source('apps/worker/src/ingestion/ban-recovery.ts');
const { WorkerRuntime } = source('apps/worker/src/ingestion/worker-runtime.ts');
const { loadConfig } = source('packages/config/src/index.ts');

test('ban dispatch defaults off and requires worker and Google authentication', () => {
  const env = {
    DATABASE_URL: 'postgresql://test:test@127.0.0.1/test',
  };

  assert.equal(loadConfig(env).YOUTUBE_BAN_ENABLED, false);

  assert.throws(() => loadConfig({ ...env, YOUTUBE_BAN_ENABLED: 'yes' }));

  assert.throws(() => loadConfig({ ...env, YOUTUBE_BAN_ENABLED: 'true' }));

  assert.throws(() =>
    loadConfig({
      ...env,
      WORKER_ENABLED: 'true',
      YOUTUBE_BAN_ENABLED: 'true',
    }),
  );

  assert.equal(
    loadConfig({
      ...env,
      WORKER_ENABLED: 'true',
      GOOGLE_AUTH_ENABLED: 'true',
      YOUTUBE_BAN_ENABLED: 'true',
      GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-only',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    }).YOUTUBE_BAN_ENABLED,
    true,
  );
});

test('disabled or cancelled scheduling never reads candidates', async () => {
  for (const enabled of [false, true]) {
    const controller = new AbortController();

    if (enabled) controller.abort();

    const coordinator = new BanCoordinator(
      {
        async next() {
          assert.fail('Unexpected candidate read');
        },
      },
      {
        async execute() {
          assert.fail('Unexpected dispatch');
        },
      },
      () => enabled,
    );

    await coordinator.tick(controller.signal);
  }
});

test('skipped candidates advance the cursor and exhaustion wraps it', async () => {
  const cursors = [];
  const requests = [];
  const candidates = [
    { planId: 'first', channelId: 'channel', sessionId: 'session' },
    { planId: 'second', channelId: 'channel', sessionId: 'session' },
    null,
    null,
  ];

  const coordinator = new BanCoordinator(
    {
      async next(cursor) {
        cursors.push(cursor);
        return candidates.shift();
      },
    },
    {
      async execute(input) {
        requests.push(input);
        return { status: 'SKIPPED', reason: 'INELIGIBLE' };
      },
    },
    () => true,
  );

  const signal = new AbortController().signal;

  for (let index = 0; index < 4; index++) {
    await coordinator.tick(signal);
  }

  assert.deepEqual(cursors, [null, 'first', 'second', null]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].ownerId, requests[1].ownerId);
});

test('cancellation during discovery prevents dispatch and overlapping ticks', async () => {
  let release;
  let reads = 0;
  const controller = new AbortController();

  const coordinator = new BanCoordinator(
    {
      async next() {
        reads++;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
    {
      async execute() {
        assert.fail('Unexpected dispatch');
      },
    },
    () => true,
  );

  const pending = coordinator.tick(controller.signal);

  await coordinator.tick(controller.signal);
  controller.abort();

  release({
    planId: 'plan',
    channelId: 'channel',
    sessionId: 'session',
  });

  await pending;
  assert.equal(reads, 1);
});

test('recovery is bounded and can resume after a database failure', async () => {
  const limits = [];

  const recovery = new BanRecovery({
    async recoverExpired(limit) {
      limits.push(limit);

      if (limits.length === 1) {
        throw new Error('Database unavailable');
      }

      return 0;
    },
  });

  const controller = new AbortController();

  await assert.rejects(recovery.tick(controller.signal), /Database unavailable/);

  await recovery.tick(controller.signal);
  controller.abort();
  await recovery.tick(controller.signal);

  assert.deepEqual(limits, [100, 100]);
});

test('runtime drains ban dispatch and recovery before closing the pool', async () => {
  const events = [];
  let finishRecovery;

  const runtime = new WorkerRuntime(
    {
      async tick() {
        return { kind: 'IDLE' };
      },
    },
    {
      async end() {
        events.push('pool-closed');
      },
    },
    undefined,
    undefined,
    {
      dispatch: {
        async tick(signal) {
          events.push('dispatch-started');

          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

          events.push('dispatch-finished');
        },
      },
      recovery: {
        async tick() {
          events.push('recovery-started');

          await new Promise((resolve) => {
            finishRecovery = resolve;
          });

          events.push('recovery-finished');
        },
      },
    },
  );

  runtime.start();

  const stopped = runtime.onApplicationShutdown();

  await Promise.resolve();
  assert.equal(events.includes('pool-closed'), false);

  finishRecovery();
  await stopped;

  assert.equal(events.at(-1), 'pool-closed');
  assert.ok(events.includes('dispatch-finished'));
  assert.ok(events.includes('recovery-finished'));
});
