const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { actionExecutionCounts, historyActionStatistics } = source(
  'packages/contracts/src/history-action-statistics.ts',
);

function emptyCounts() {
  return {
    total: 0,
    dispatched: 0,
    succeeded: 0,
    rejected: 0,
    not_sent: 0,
    unknown: 0,
  };
}

function emptyStatistics() {
  return {
    session_id: '10000000-0000-4000-8000-000000000001',
    delete: emptyCounts(),
    timeout: emptyCounts(),
    ban: emptyCounts(),
  };
}

test('a session without attempted executions has zero action counts', () => {
  const input = emptyStatistics();

  assert.deepEqual(historyActionStatistics.parse(input), input);
});

test('repeated timeouts can have separate successful and unknown outcomes', () => {
  const input = {
    ...emptyStatistics(),
    timeout: {
      total: 3,
      dispatched: 0,
      succeeded: 2,
      rejected: 0,
      not_sent: 0,
      unknown: 1,
    },
  };

  const result = historyActionStatistics.parse(input);

  assert.equal(result.timeout.total, 3);
  assert.equal(result.timeout.succeeded, 2);
  assert.equal(result.timeout.unknown, 1);
});

test('each action must have internally consistent counts', () => {
  for (const action of ['delete', 'timeout', 'ban']) {
    const input = emptyStatistics();
    input[action] = {
      ...emptyCounts(),
      total: 1,
    };

    assert.equal(historyActionStatistics.safeParse(input).success, false);
  }
});

test('counts reject negative, fractional, unsafe and nonnumeric values', () => {
  for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.equal(
      actionExecutionCounts.safeParse({
        ...emptyCounts(),
        total: value,
        succeeded: value,
      }).success,
      false,
    );
  }
});

test('unknown outcomes cannot be counted again as successful', () => {
  assert.equal(
    actionExecutionCounts.safeParse({
      ...emptyCounts(),
      total: 1,
      succeeded: 1,
      unknown: 1,
    }).success,
    false,
  );
});

test('all action groups and a valid session identifier are required', () => {
  const { ban, ...withoutBan } = emptyStatistics();

  assert.equal(historyActionStatistics.safeParse(withoutBan).success, false);

  assert.equal(
    historyActionStatistics.safeParse({
      ...emptyStatistics(),
      session_id: 'invalid',
    }).success,
    false,
  );
});

test('pending executions are not part of attempted execution counts', () => {
  assert.equal(
    actionExecutionCounts.safeParse({
      ...emptyCounts(),
      pending: 1,
    }).success,
    false,
  );
});
