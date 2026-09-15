const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');

const { source } = require('./helpers/source.cjs');
const { appendLiveEvent, transaction } = source('packages/persistence/src/index.ts');

const schema = `live_event_${randomUUID().replaceAll('-', '')}`;

let pool;
let client;
let migrate;
let schemaCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
  }

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Chat observation tests require a local database.');
  }

  ({ migrate } = await import('../scripts/database.mjs'));

  client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await client.query(`SET search_path TO ${schema}`);
  await migrate(client);
  pool = new Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
    options: `-c search_path=${schema}`,
  });
});

after(async () => {
  try {
    if (pool) await pool.end();
  } finally {
    if (client) {
      try {
        if (schemaCreated) await client.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await client.end();
      }
    }
  }
});

async function fixture() {
  const accountId = randomUUID();
  const channelId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();

  await client.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    accountId,
    'Chat observation test account',
  ]);

  await client.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
    channelId,
    'Chat observation test channel',
  ]);

  await client.query(
    `
      INSERT INTO youtube_channels(channel_id, youtube_channel_id)
      VALUES($1, $2)
    `,
    [channelId, `channel-${randomUUID()}`],
  );

  await client.query(
    `
      INSERT INTO stream_sessions(id, channel_id, label, source)
      VALUES($1, $2, 'Chat observation test broadcast', 'YOUTUBE')
    `,
    [sessionId, channelId],
  );

  await client.query(
    `
      INSERT INTO youtube_broadcasts(
        session_id, channel_id, youtube_broadcast_id, live_chat_id
      )
      VALUES($1, $2, $3, $4)
    `,
    [sessionId, channelId, `broadcast-${randomUUID()}`, `chat-${randomUUID()}`],
  );

  await client.query(
    `
      INSERT INTO monitoring_runs(
        id, channel_id, session_id,
        requested_by_account_id, credential_account_id
      )
      VALUES($1, $2, $3, $4, $4)
    `,
    [runId, channelId, sessionId, accountId],
  );

  return { accountId, channelId, sessionId, runId };
}

function eventInput(f, type = 'chat.updated') {
  return {
    channelId: f.channelId,
    sessionId: f.sessionId,
    runId: f.runId,
    type,
  };
}

function append(f, type) {
  return transaction(pool, (connection) => appendLiveEvent(connection, eventInput(f, type)));
}

test('live event migration can be applied repeatedly', async () => {
  await migrate(client);

  const result = await client.query('SELECT name FROM schema_migrations WHERE name = $1', [
    '009_live_event_feed.sql',
  ]);

  assert.equal(result.rows.length, 1);
});

test('concurrent events receive unique ordered sequences within a session', async () => {
  const f = await fixture();

  const results = await Promise.all(Array.from({ length: 4 }, () => append(f)));

  assert.deepEqual(
    results.map((result) => Number(result.sequence)).sort((a, b) => a - b),
    [1, 2, 3, 4],
  );

  const stored = await client.query(
    `
      SELECT sequence::text
      FROM live_events
      WHERE channel_id = $1 AND session_id = $2
      ORDER BY sequence
    `,
    [f.channelId, f.sessionId],
  );

  assert.deepEqual(
    stored.rows.map((row) => row.sequence),
    ['1', '2', '3', '4'],
  );
});

test('rollback removes the event and rolls back its sequence allocation', async () => {
  const f = await fixture();

  await assert.rejects(
    transaction(pool, async (connection) => {
      await appendLiveEvent(connection, eventInput(f));
      throw new Error('Simulated transaction failure');
    }),
    /Simulated transaction failure/,
  );

  const stored = await client.query('SELECT sequence FROM live_events WHERE session_id = $1', [
    f.sessionId,
  ]);
  assert.equal(stored.rows.length, 0);

  assert.deepEqual(await append(f), { sequence: '1' });
});

test('each session has an independent sequence', async () => {
  const first = await fixture();
  const second = await fixture();

  assert.deepEqual(await append(first), { sequence: '1' });
  assert.deepEqual(await append(first, 'monitoring.updated'), { sequence: '2' });
  assert.deepEqual(await append(second), { sequence: '1' });
});

test('events cannot reference a monitoring run from another session', async () => {
  const first = await fixture();
  const second = await fixture();

  await assert.rejects(
    transaction(pool, (connection) =>
      appendLiveEvent(connection, {
        ...eventInput(first),
        runId: second.runId,
      }),
    ),
    (error) => error.code === '23503',
  );

  assert.deepEqual(await append(first), { sequence: '1' });
});

test('stored events cannot be updated', async () => {
  const f = await fixture();
  await append(f);

  await assert.rejects(
    client.query(
      `
        UPDATE live_events
        SET event_type = 'monitoring.updated'
        WHERE session_id = $1
      `,
      [f.sessionId],
    ),
    (error) => error.code === '23514',
  );
});
