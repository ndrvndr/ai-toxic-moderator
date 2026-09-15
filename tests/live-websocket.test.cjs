require('reflect-metadata');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocket } = require('ws');

const { source } = require('./helpers/source.cjs');
const { LiveGateway } = source('apps/api/src/live/live.gateway.ts');
const { LiveAccessError } = source('apps/api/src/live/live-access.service.ts');

const origin = 'http://127.0.0.1:3000';
const token = 'a'.repeat(43);

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(10);
  }

  throw new Error('Timed out waiting for a WebSocket result.');
}

async function fixture(t, read) {
  const server = createServer();
  const gateway = new LiveGateway(
    { httpAdapter: { getHttpServer: () => server } },
    { DASHBOARD_ORIGIN: origin },
    { read },
  );

  gateway.onModuleInit();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(async () => {
    await gateway.onModuleDestroy();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const channelId = randomUUID();
  const sessionId = randomUUID();
  const url =
    `ws://127.0.0.1:${server.address().port}/v1/live` +
    `?channel_id=${channelId}&session_id=${sessionId}`;

  return { url, gateway };
}

function connect(url, headers = {}) {
  const socket = new WebSocket(url, {
    headers: {
      Origin: origin,
      Cookie: `atm_dev_session=${token}`,
      ...headers,
    },
  });

  const result = {
    socket,
    messages: [],
    rejected: null,
    closed: null,
  };

  socket.on('message', (data) => {
    result.messages.push(JSON.parse(data.toString()));
  });

  socket.on('unexpected-response', (_request, response) => {
    result.rejected = response.statusCode;
    response.resume();
    socket.terminate();
  });

  socket.on('close', (code) => {
    result.closed = code;
  });

  socket.on('error', () => {});

  return result;
}

test('untrusted origins are rejected before accessing the feed', async (t) => {
  let reads = 0;

  const { url } = await fixture(t, async () => {
    reads += 1;
    throw new Error('The feed must not be accessed.');
  });

  const connection = connect(url, { Origin: 'http://localhost:9999' });

  await waitFor(() => connection.rejected);

  assert.equal(connection.rejected, 403);
  assert.equal(reads, 0);
});

test('missing authentication rejects the upgrade', async (t) => {
  const { url } = await fixture(t, async (receivedToken) => {
    assert.equal(receivedToken, null);
    throw new LiveAccessError(401, 4001, 'Authentication required.');
  });

  const connection = connect(url, { Cookie: '' });

  await waitFor(() => connection.rejected);

  assert.equal(connection.rejected, 401);
});

test('events replay after the supplied cursor and revoked access closes the socket', async (t) => {
  let revoked = false;

  const events = [
    {
      sequence: '1',
      run_id: randomUUID(),
      event_type: 'chat.updated',
    },
    {
      sequence: '2',
      run_id: randomUUID(),
      event_type: 'monitoring.updated',
    },
  ];

  const { url } = await fixture(t, async (receivedToken, subscription) => {
    assert.equal(receivedToken, token);

    if (revoked) {
      throw new LiveAccessError(403, 4003, 'Channel access denied.');
    }

    const cursor = subscription.after ?? '2';
    const items = events.filter((event) => BigInt(event.sequence) > BigInt(cursor));

    return {
      watermark: '2',
      next_cursor: items.at(-1)?.sequence ?? cursor,
      has_more: false,
      items,
    };
  });

  const connection = connect(`${url}&after=1`);

  await waitFor(() => connection.messages.length >= 2);

  assert.equal(connection.messages[0].type, 'ready');
  assert.equal(connection.messages[0].cursor, '1');
  assert.equal(connection.messages[1].type, 'events');
  assert.equal(connection.messages[1].cursor, '2');
  assert.deepEqual(connection.messages[1].items, [events[1]]);

  revoked = true;

  await waitFor(() => connection.closed !== null);

  assert.equal(connection.closed, 4003);
});

test('a fresh connection starts at the current watermark', async (t) => {
  const { url } = await fixture(t, async () => ({
    watermark: '12',
    next_cursor: '12',
    has_more: false,
    items: [],
  }));

  const connection = connect(url);

  await waitFor(() => connection.messages.length > 0);

  assert.equal(connection.messages[0].type, 'ready');
  assert.equal(connection.messages[0].cursor, '12');

  connection.socket.close();
});

test('duplicate subscription parameters are rejected', async (t) => {
  const { url } = await fixture(t, async () => {
    throw new Error('The feed must not be accessed.');
  });

  const connection = connect(`${url}&after=0&after=1`);

  await waitFor(() => connection.rejected);

  assert.equal(connection.rejected, 400);
});
