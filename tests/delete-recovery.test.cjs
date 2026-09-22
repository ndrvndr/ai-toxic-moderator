const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { DeleteRecovery } = source('apps/worker/src/ingestion/delete-recovery.ts');

test('recovery processes one bounded batch per tick without dispatch dependencies', async () => {
  const limits = [];
  const recovery = new DeleteRecovery({
    async recoverExpired(limit) {
      limits.push(limit);
      return limit;
    },
  });
  const signal = new AbortController().signal;
  await recovery.tick(signal);
  assert.deepEqual(limits, [100]);
  await recovery.tick(signal);
  assert.deepEqual(limits, [100, 100]);
});

test('an aborted tick does not start recovery', async () => {
  const controller = new AbortController();
  controller.abort();
  const recovery = new DeleteRecovery({
    async recoverExpired() {
      assert.fail('Unexpected recovery query');
    },
  });
  await recovery.tick(controller.signal);
});

test('overlapping ticks do not duplicate work and shutdown drains an in-flight update', async () => {
  let release;
  let calls = 0;
  let finished = false;
  const controller = new AbortController();
  const recovery = new DeleteRecovery({
    async recoverExpired() {
      calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
      return 1;
    },
  });
  const first = recovery.tick(controller.signal).then(() => {
    finished = true;
  });
  await recovery.tick(controller.signal);
  assert.equal(calls, 1);
  controller.abort();
  await recovery.tick(controller.signal);
  assert.equal(finished, false);
  release();
  await first;
  assert.equal(finished, true);
  assert.equal(calls, 1);
});

test('a database error releases the guard so a later tick can recover again', async () => {
  let calls = 0;
  const recovery = new DeleteRecovery({
    async recoverExpired() {
      if (++calls === 1) throw Error('Database unavailable');
      return 0;
    },
  });
  const signal = new AbortController().signal;
  await assert.rejects(recovery.tick(signal), /Database unavailable/);
  await recovery.tick(signal);
  assert.equal(calls, 2);
});
