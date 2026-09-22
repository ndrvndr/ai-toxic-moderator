const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { DeleteCoordinator } = source('apps/worker/src/ingestion/delete-coordinator.ts');
const { loadConfig } = source('packages/config/src/index.ts');

test('deletion defaults off and requires both worker and Google authentication', () => {
  const env = { DATABASE_URL: 'postgresql://test:test@127.0.0.1/test' };
  assert.equal(loadConfig(env).YOUTUBE_DELETE_ENABLED, false);
  assert.throws(() => loadConfig({ ...env, YOUTUBE_DELETE_ENABLED: 'yes' }));
  assert.throws(() => loadConfig({ ...env, YOUTUBE_DELETE_ENABLED: 'true' }));
  assert.throws(() =>
    loadConfig({ ...env, WORKER_ENABLED: 'true', YOUTUBE_DELETE_ENABLED: 'true' }),
  );
  assert.equal(
    loadConfig({
      ...env,
      WORKER_ENABLED: 'true',
      YOUTUBE_DELETE_ENABLED: 'true',
      GOOGLE_AUTH_ENABLED: 'true',
      GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-only',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    }).YOUTUBE_DELETE_ENABLED,
    true,
  );
});

test('disabled or cancelled scheduling never reads plans or dispatches', async () => {
  for (const enabled of [false, true]) {
    const controller = new AbortController();
    if (enabled) controller.abort();
    const coordinator = new DeleteCoordinator(
      {
        async next() {
          assert.fail('Unexpected discovery');
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

test('skipped plans advance the scan and exhaustion wraps for a later tick', async () => {
  const cursors = [];
  const requests = [];
  const plans = [
    { planId: 'first', channelId: 'channel', sessionId: 'session' },
    { planId: 'second', channelId: 'channel', sessionId: 'session' },
    null,
    null,
  ];
  const coordinator = new DeleteCoordinator(
    {
      async next(cursor) {
        cursors.push(cursor);
        return plans.shift();
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
  for (let i = 0; i < 4; i++) await coordinator.tick(signal);
  assert.deepEqual(cursors, [null, 'first', 'second', null]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].ownerId, requests[1].ownerId);
  assert.equal(requests[0].signal, signal);
});

test('shutdown during discovery prevents dispatch and overlapping ticks are ignored', async () => {
  let release;
  let reads = 0;
  const controller = new AbortController();
  const coordinator = new DeleteCoordinator(
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
  release({ planId: 'plan', channelId: 'channel', sessionId: 'session' });
  await pending;
  assert.equal(reads, 1);
});

test('an execution error releases the scheduler and does not pin the scan cursor', async () => {
  const cursors = [];
  const coordinator = new DeleteCoordinator(
    {
      async next(cursor) {
        cursors.push(cursor);
        return cursor ? null : { planId: 'plan' };
      },
    },
    {
      async execute() {
        throw Error('Simulated database failure');
      },
    },
    () => true,
  );
  const signal = new AbortController().signal;
  await assert.rejects(coordinator.tick(signal), /Simulated/);
  await coordinator.tick(signal);
  assert.deepEqual(cursors, [null, 'plan']);
});
