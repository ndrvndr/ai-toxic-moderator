const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { source } = require('./helpers/source.cjs');

const { startMonitoringInput, stopMonitoringInput, monitoringRequestKey, monitoringRun } = source(
  'packages/contracts/src/monitoring.ts',
);

function run(overrides = {}) {
  return {
    id: randomUUID(),
    channel_id: randomUUID(),
    session_id: randomUUID(),
    youtube_broadcast_id: 'test-live-1',
    status: 'STARTING',
    requested_at: '2026-09-14T10:00:00.000Z',
    started_at: null,
    stop_requested_at: null,
    finished_at: null,
    last_error_code: null,
    ...overrides,
  };
}

test('start accepts only a broadcast ID', () => {
  assert.equal(
    startMonitoringInput.safeParse({
      youtube_broadcast_id: 'test-live-1',
    }).success,
    true,
  );

  for (const extra of [
    { account_id: randomUUID() },
    { channel_id: randomUUID() },
    { live_chat_id: 'client-supplied-chat' },
    { status: 'RUNNING' },
  ]) {
    assert.equal(
      startMonitoringInput.safeParse({
        youtube_broadcast_id: 'test-live-1',
        ...extra,
      }).success,
      false,
    );
  }
});

test('stop requires an empty object', () => {
  assert.equal(stopMonitoringInput.safeParse({}).success, true);
  assert.equal(stopMonitoringInput.safeParse({ account_id: randomUUID() }).success, false);
});

test('idempotency keys must be UUIDs', () => {
  assert.equal(monitoringRequestKey.safeParse(randomUUID()).success, true);
  assert.equal(monitoringRequestKey.safeParse('invalid').success, false);
});

test('running requires a start timestamp', () => {
  assert.equal(monitoringRun.safeParse(run({ status: 'RUNNING' })).success, false);

  assert.equal(
    monitoringRun.safeParse(
      run({
        status: 'RUNNING',
        started_at: '2026-09-14T10:00:01.000Z',
      }),
    ).success,
    true,
  );
});

test('terminal states require completion and active states forbid it', () => {
  for (const status of ['STOPPED', 'FAILED']) {
    assert.equal(monitoringRun.safeParse(run({ status })).success, false);

    assert.equal(
      monitoringRun.safeParse(
        run({
          status,
          finished_at: '2026-09-14T10:00:02.000Z',
        }),
      ).success,
      true,
    );
  }

  assert.equal(
    monitoringRun.safeParse(run({ finished_at: '2026-09-14T10:00:02.000Z' })).success,
    false,
  );
});

test('completion cannot precede the actual start', () => {
  assert.equal(
    monitoringRun.safeParse(
      run({
        status: 'STOPPED',
        started_at: '2026-09-14T10:00:05.000Z',
        finished_at: '2026-09-14T10:00:02.000Z',
      }),
    ).success,
    false,
  );
});
