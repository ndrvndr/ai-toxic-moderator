const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { source } = require('./helpers/source.cjs');
const { consumeLiveFrame } = source('apps/dashboard/features/live/lib/live-event-protocol.ts');

const scope = {
  channelId: randomUUID(),
  sessionId: randomUUID(),
};

function frame(type, cursor, items) {
  return JSON.stringify({
    type,
    channel_id: scope.channelId,
    session_id: scope.sessionId,
    cursor,
    ...(items ? { items } : {}),
  });
}

function event(sequence, event_type = 'chat.updated') {
  return {
    sequence,
    run_id: randomUUID(),
    event_type,
  };
}

test('ready requests a fresh snapshot', () => {
  const result = consumeLiveFrame(frame('ready', '12'), scope, {
    cursor: null,
    ready: false,
  });

  assert.deepEqual(result, {
    cursor: '12',
    ready: true,
    refreshChat: true,
    refreshMonitoring: true,
  });
});

test('reconnect must acknowledge the requested cursor', () => {
  assert.throws(() =>
    consumeLiveFrame(frame('ready', '13'), scope, {
      cursor: '12',
      ready: false,
    }),
  );
});

test('ordered events refresh only their affected resources', () => {
  const result = consumeLiveFrame(frame('events', '2', [event('1'), event('2')]), scope, {
    cursor: '0',
    ready: true,
  });

  assert.equal(result.cursor, '2');
  assert.equal(result.refreshChat, true);
  assert.equal(result.refreshMonitoring, false);
});

test('duplicate replay does not move the cursor backwards', () => {
  const result = consumeLiveFrame(frame('events', '1', [event('1')]), scope, {
    cursor: '2',
    ready: true,
  });

  assert.equal(result.cursor, '2');
  assert.equal(result.refreshChat, false);
  assert.equal(result.refreshMonitoring, false);
});

test('gaps and out-of-order events are rejected', () => {
  for (const items of [[event('2')], [event('2'), event('1')]]) {
    assert.throws(() =>
      consumeLiveFrame(frame('events', items.at(-1).sequence, items), scope, {
        cursor: '0',
        ready: true,
      }),
    );
  }
});

test('events from another session are rejected', () => {
  assert.throws(() =>
    consumeLiveFrame(
      frame('ready', '0'),
      { ...scope, sessionId: randomUUID() },
      { cursor: null, ready: false },
    ),
  );
});

test('events before ready are rejected', () => {
  assert.throws(() =>
    consumeLiveFrame(frame('events', '1', [event('1')]), scope, {
      cursor: '0',
      ready: false,
    }),
  );
});

test('large sequences retain precision', () => {
  const result = consumeLiveFrame(
    frame('events', '9007199254740993', [event('9007199254740993', 'monitoring.updated')]),
    scope,
    { cursor: '9007199254740992', ready: true },
  );

  assert.equal(result.cursor, '9007199254740993');
  assert.equal(result.refreshMonitoring, true);
});
