const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { unbanRequest, unbanSummary } = source('packages/contracts/src/unban.ts');
const requestId = '10000000-0000-4000-8000-000000000001';
const identity = {
  id: requestId,
  execution_id: '20000000-0000-4000-8000-000000000002',
  requested_at: '2026-10-05T00:00:00Z',
};

test('the two intents are explicit and Studio removal requires confirmation', () => {
  for (const input of [
    { request_id: requestId, method: 'YOUTUBE' },
    { request_id: requestId, method: 'STUDIO_CONFIRMATION', confirmed: true },
  ])
    assert.deepEqual(unbanRequest.parse(input), input);
  for (const input of [
    { request_id: requestId, method: 'STUDIO_CONFIRMATION' },
    { request_id: requestId, method: 'STUDIO_CONFIRMATION', confirmed: false },
    { request_id: 'invalid', method: 'YOUTUBE' },
    { request_id: requestId, method: 'AUTO' },
  ])
    assert.equal(unbanRequest.safeParse(input).success, false);
});

test('clients cannot supply provider IDs, credentials, targets or outcomes', () => {
  for (const extra of [
    { ban_id: 'provider-ban' },
    { access_token: 'fixture' },
    { author_channel_id: 'viewer' },
    { channel_id: requestId },
    { status: 'SUCCEEDED' },
  ])
    assert.equal(
      unbanRequest.safeParse({ request_id: requestId, method: 'YOUTUBE', ...extra }).success,
      false,
    );
});

test('Studio reports remain user-confirmed rather than provider-confirmed', () => {
  const record = {
    ...identity,
    method: 'STUDIO_CONFIRMATION',
    status: 'USER_CONFIRMED',
    finished_at: identity.requested_at,
  };
  assert.deepEqual(unbanSummary.parse(record), record);
  assert.equal(unbanSummary.safeParse({ ...record, status: 'SUCCEEDED' }).success, false);
  assert.equal(unbanSummary.safeParse({ ...record, finished_at: null }).success, false);
  assert.equal(
    unbanSummary.safeParse({ ...record, finished_at: '2026-10-04T00:00:00Z' }).success,
    false,
  );
});

test('provider outcomes retain uncertainty and require valid completion times', () => {
  const pending = { ...identity, method: 'YOUTUBE', status: 'DISPATCHED', finished_at: null };
  assert.deepEqual(unbanSummary.parse(pending), pending);
  assert.equal(
    unbanSummary.safeParse({ ...pending, finished_at: identity.requested_at }).success,
    false,
  );
  for (const status of ['SUCCEEDED', 'REJECTED', 'NOT_SENT', 'UNKNOWN']) {
    assert.equal(
      unbanSummary.safeParse({ ...pending, status, finished_at: identity.requested_at }).success,
      true,
    );
    assert.equal(unbanSummary.safeParse({ ...pending, status }).success, false);
    assert.equal(
      unbanSummary.safeParse({ ...pending, status, finished_at: '2026-10-04T00:00:00Z' }).success,
      false,
    );
  }
  assert.equal(
    unbanSummary.safeParse({
      ...pending,
      status: 'USER_CONFIRMED',
      finished_at: identity.requested_at,
    }).success,
    false,
  );
});
