const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { aiOperationalStatus, aiOperationalStatusResponse } = source(
  'packages/contracts/src/index.ts',
);

const channel = '10000000-0000-4000-8000-000000000001';
const run = '20000000-0000-4000-8000-000000000002';
const session = '30000000-0000-4000-8000-000000000003';
const base = {
  channel_id: channel,
  session_id: null,
  run_id: null,
  updated_at: '2026-10-04T12:00:00Z',
  heartbeat_at: '2026-10-04T12:00:10Z',
  error_code: null,
};
const selected = { session_id: session, run_id: run };
const reports = [
  { ...base, status: 'DISABLED', reason: 'WORKER_AI_DISABLED' },
  { ...base, ...selected, status: 'DISABLED', reason: 'RUN_AI_DISABLED' },
  { ...base, status: 'WAITING', reason: 'NO_ELIGIBLE_RUN' },
  { ...base, ...selected, status: 'ACTIVE', reason: 'RUN_SELECTED' },
  { ...base, ...selected, status: 'MODEL_MISMATCH', reason: 'CAPTURED_MODEL_MISMATCH' },
  { ...base, status: 'CAPACITY_EXCEEDED', reason: 'MULTIPLE_ELIGIBLE_RUNS' },
  { ...base, status: 'ERROR', reason: 'PROCESSING_FAILED', error_code: 'DATABASE_UNAVAILABLE' },
  {
    ...base,
    ...selected,
    status: 'ERROR',
    reason: 'PROCESSING_FAILED',
    error_code: 'INFERENCE_TIMEOUT',
  },
];

test('public barrel accepts each operational state and safe error scope', () => {
  for (const report of reports) assert.deepEqual(aiOperationalStatus.parse(report), report);
});

test('state and reason cannot contradict each other or claim provider execution', () => {
  for (const report of reports) {
    for (const change of [
      { reason: 'SUCCEEDED' },
      { status: 'BAN_CONFIRMED' },
      { action: 'BAN' },
      { error_code: 'postgresql://owner:secret@localhost/db' },
      { raw_error: 'stack and private connection details' },
      { worker_id: 'private-worker' },
    ])
      assert.equal(aiOperationalStatus.safeParse({ ...report, ...change }).success, false);
  }
  assert.equal(
    aiOperationalStatus.safeParse({ ...reports[3], reason: 'NO_ELIGIBLE_RUN' }).success,
    false,
  );
  assert.equal(aiOperationalStatus.safeParse({ ...reports[6], error_code: null }).success, false);
  assert.equal(
    aiOperationalStatus.safeParse({ ...reports[3], error_code: 'INFERENCE_FAILED' }).success,
    false,
  );
});

test('scope cannot be partial or falsely identify a selected run', () => {
  for (const report of reports) {
    assert.equal(
      aiOperationalStatus.safeParse({ ...report, run_id: run, session_id: null }).success,
      false,
    );
    assert.equal(
      aiOperationalStatus.safeParse({ ...report, run_id: null, session_id: session }).success,
      false,
    );
  }
  for (const report of [reports[3], reports[4]]) {
    assert.equal(
      aiOperationalStatus.safeParse({ ...report, run_id: null, session_id: null }).success,
      false,
    );
  }
  for (const report of [reports[0], reports[2], reports[5]]) {
    assert.equal(aiOperationalStatus.safeParse({ ...report, ...selected }).success, false);
  }
  assert.equal(
    aiOperationalStatus.safeParse({ ...reports[1], run_id: null, session_id: null }).success,
    false,
  );
});

test('timestamps preserve state-change ordering including timezone offsets', () => {
  assert.equal(
    aiOperationalStatus.safeParse({ ...reports[3], heartbeat_at: base.updated_at }).success,
    true,
  );
  assert.equal(
    aiOperationalStatus.safeParse({ ...reports[3], heartbeat_at: '2026-10-04T18:59:59+07:00' })
      .success,
    false,
  );
  assert.equal(
    aiOperationalStatus.safeParse({ ...reports[3], updated_at: 'not-a-date' }).success,
    false,
  );
});

const response = {
  channel_id: channel,
  checked_at: '2026-10-04T12:00:39Z',
  stale_after_ms: 30_000,
  availability: 'ONLINE',
  report: reports[3],
};

test('heartbeat expiry preserves the last report without claiming it is online', () => {
  assert.deepEqual(aiOperationalStatusResponse.parse(response), response);
  const expired = { ...response, checked_at: '2026-10-04T12:00:40Z', availability: 'STALE' };
  assert.deepEqual(aiOperationalStatusResponse.parse(expired), expired);
  assert.equal(
    aiOperationalStatusResponse.safeParse({ ...expired, availability: 'ONLINE' }).success,
    false,
  );
  assert.equal(
    aiOperationalStatusResponse.safeParse({ ...response, availability: 'STALE' }).success,
    false,
  );
  assert.equal(
    aiOperationalStatusResponse.safeParse({ ...response, checked_at: '2026-10-04T12:00:09Z' })
      .success,
    false,
  );
});

test('missing reports are unknown rather than evidence of disabled AI or a dead worker', () => {
  const unknown = { ...response, availability: 'UNKNOWN', report: null };
  assert.deepEqual(aiOperationalStatusResponse.parse(unknown), unknown);
  for (const availability of ['ONLINE', 'STALE']) {
    assert.equal(
      aiOperationalStatusResponse.safeParse({ ...unknown, availability }).success,
      false,
    );
  }
  assert.equal(
    aiOperationalStatusResponse.safeParse({ ...response, availability: 'UNKNOWN' }).success,
    false,
  );
});

test('response rejects cross-channel reports, missing heartbeat fields and unsafe additions', () => {
  for (const change of [
    { channel_id: run },
    { stale_after_ms: 0 },
    { stale_after_ms: 300_001 },
    { stale_after_ms: 1.5 },
    { checked_at: undefined },
    { report: { ...reports[3], heartbeat_at: undefined } },
    { connection_url: 'private' },
  ])
    assert.equal(aiOperationalStatusResponse.safeParse({ ...response, ...change }).success, false);
});
