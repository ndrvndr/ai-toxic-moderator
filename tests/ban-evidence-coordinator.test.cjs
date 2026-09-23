const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { BanEvidenceCoordinator } = source('apps/worker/src/ingestion/ban-evidence-coordinator.ts');

function page(ids, nextCursor = null) {
  return {
    attemptId: 'attempt-1',
    matches: ids.map((observationId) => ({
      observationId,
      attribution: 'UNPROVEN',
    })),
    nextCursor,
  };
}

test('reads one page per tick and rescans after the cooldown', async () => {
  let now = 0;
  const discoveries = [];
  const reads = [];
  const saves = [];
  const candidates = ['attempt-1', null, 'attempt-1'];
  const pages = [page(['event-1'], 'cursor-1'), page(['event-2']), page(['late-event'])];

  const coordinator = new BanEvidenceCoordinator(
    {
      async nextAttempt(after) {
        discoveries.push(after);
        return candidates.shift();
      },
      async read(attemptId, after, limit) {
        reads.push([attemptId, after, limit]);
        return pages.shift();
      },
    },
    {
      async save(attemptId, observationId) {
        saves.push([attemptId, observationId]);
        return 'INSERTED';
      },
    },
    () => now,
  );

  const signal = new AbortController().signal;

  await coordinator.tick(signal);
  assert.equal(reads.length, 1);

  await coordinator.tick(signal);
  await coordinator.tick(signal);

  now = 29_999;
  await coordinator.tick(signal);
  assert.equal(discoveries.length, 2);

  now = 30_000;
  await coordinator.tick(signal);

  assert.deepEqual(discoveries, [null, 'attempt-1', null]);
  assert.deepEqual(reads, [
    ['attempt-1', null, 100],
    ['attempt-1', 'cursor-1', 100],
    ['attempt-1', null, 100],
  ]);
  assert.deepEqual(saves, [
    ['attempt-1', 'event-1'],
    ['attempt-1', 'event-2'],
    ['attempt-1', 'late-event'],
  ]);
});

test('partial persistence failure replays the page before advancing', async () => {
  const reads = [];
  const saves = [];
  let fail = true;

  const coordinator = new BanEvidenceCoordinator(
    {
      async nextAttempt() {
        return 'attempt-1';
      },
      async read(_attemptId, cursor) {
        reads.push(cursor);

        return cursor === null ? page(['event-1', 'event-2'], 'cursor-1') : page([]);
      },
    },
    {
      async save(_attemptId, observationId) {
        saves.push(observationId);

        if (observationId === 'event-2' && fail) {
          fail = false;
          throw new Error('Database unavailable');
        }

        return 'EXISTING';
      },
    },
  );

  const signal = new AbortController().signal;

  await assert.rejects(coordinator.tick(signal), /Database unavailable/);
  await coordinator.tick(signal);
  await coordinator.tick(signal);

  assert.deepEqual(reads, [null, null, 'cursor-1']);
  assert.deepEqual(saves, ['event-1', 'event-2', 'event-1', 'event-2']);
});

test('overlapping ticks are ignored and cancellation prevents persistence', async () => {
  let release;
  let reads = 0;
  const controller = new AbortController();

  const coordinator = new BanEvidenceCoordinator(
    {
      async nextAttempt() {
        reads += 1;

        return new Promise((resolve) => {
          release = resolve;
        });
      },
      async read() {
        assert.fail('Unexpected page read');
      },
    },
    {
      async save() {
        assert.fail('Unexpected evidence write');
      },
    },
  );

  const pending = coordinator.tick(controller.signal);

  await coordinator.tick(controller.signal);
  controller.abort();
  release('attempt-1');

  await pending;
  await coordinator.tick(controller.signal);

  assert.equal(reads, 1);
});

test('cancellation during persistence stops before the next evidence write', async () => {
  const controller = new AbortController();
  const saved = [];

  const coordinator = new BanEvidenceCoordinator(
    {
      async nextAttempt() {
        return 'attempt-1';
      },
      async read() {
        return page(['event-1', 'event-2']);
      },
    },
    {
      async save(_attemptId, observationId) {
        saved.push(observationId);
        controller.abort();
        return 'INSERTED';
      },
    },
  );

  await coordinator.tick(controller.signal);

  assert.deepEqual(saved, ['event-1']);
});

test('a no-longer-eligible attempt does not block later attempts', async () => {
  const cursors = [];

  const coordinator = new BanEvidenceCoordinator(
    {
      async nextAttempt(cursor) {
        cursors.push(cursor);
        return cursor === null ? 'attempt-1' : null;
      },
      async read() {
        return null;
      },
    },
    {
      async save() {
        assert.fail('Unexpected evidence write');
      },
    },
  );

  const signal = new AbortController().signal;

  await coordinator.tick(signal);
  await coordinator.tick(signal);

  assert.deepEqual(cursors, [null, 'attempt-1']);
});
