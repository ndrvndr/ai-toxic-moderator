const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Client } = require('pg');

const schema = `chat_observation_${randomUUID().replaceAll('-', '')}`;

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
});

after(async () => {
  if (!client) return;

  try {
    if (schemaCreated) await client.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await client.end();
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

async function insertObservation(
  f,
  {
    externalId = 'message-1',
    eventType = 'textMessageEvent',
    payload = { text: 'Test message' },
    hash,
  } = {},
) {
  const id = randomUUID();
  const json = JSON.stringify(payload);
  const payloadHash = hash ?? createHash('sha256').update(json).digest('hex');

  await client.query(
    `
      INSERT INTO youtube_chat_observations(
        id,
        channel_id,
        session_id,
        first_observed_run_id,
        external_message_id,
        event_type,
        published_at,
        payload,
        payload_hash
      )
      VALUES($1, $2, $3, $4, $5, $6, clock_timestamp(), $7::jsonb, $8)
    `,
    [id, f.channelId, f.sessionId, f.runId, externalId, eventType, json, payloadHash],
  );

  return id;
}

test('observation migration can be applied repeatedly', async () => {
  await migrate(client);

  const result = await client.query('SELECT name FROM schema_migrations WHERE name = $1', [
    '006_youtube_chat_observations.sql',
  ]);

  assert.equal(result.rows.length, 1);
});

test('identical snapshots are deduplicated within a session', async () => {
  const f = await fixture();

  await insertObservation(f);

  await assert.rejects(insertObservation(f), (error) => error.code === '23505');
});

test('changed snapshots preserve the same external message identity', async () => {
  const f = await fixture();

  await insertObservation(f, {
    eventType: 'giftEvent',
    payload: { comboCount: 1 },
  });

  await insertObservation(f, {
    eventType: 'giftEvent',
    payload: { comboCount: 2 },
  });

  const result = await client.query(
    `
      SELECT
        count(*)::int AS snapshots,
        count(DISTINCT external_message_id)::int AS messages
      FROM youtube_chat_observations
      WHERE session_id = $1
    `,
    [f.sessionId],
  );

  assert.deepEqual(result.rows[0], { snapshots: 2, messages: 1 });
});

test('provenance cannot reference a run from another session', async () => {
  const first = await fixture();
  const second = await fixture();

  await assert.rejects(
    insertObservation({ ...first, runId: second.runId }),
    (error) => error.code === '23503',
  );
});

test('observations cannot be updated after insertion', async () => {
  const f = await fixture();
  const id = await insertObservation(f);

  await assert.rejects(
    client.query("UPDATE youtube_chat_observations SET payload = '{}'::jsonb WHERE id = $1", [id]),
    (error) => error.code === '23514',
  );
});

test('events without text or author fields can be stored', async () => {
  const f = await fixture();

  await insertObservation(f, {
    eventType: 'tombstone',
    payload: {
      snippet: {
        type: 'tombstone',
        liveChatId: 'test-chat',
        publishedAt: '2026-01-01T00:00:00Z',
      },
    },
  });

  const result = await client.query(
    'SELECT event_type FROM youtube_chat_observations WHERE session_id = $1',
    [f.sessionId],
  );

  assert.equal(result.rows[0].event_type, 'tombstone');
});

test('invalid payload shapes and hash formats are rejected', async () => {
  const f = await fixture();

  await assert.rejects(insertObservation(f, { payload: [] }), (error) => error.code === '23514');

  await assert.rejects(
    insertObservation(f, { hash: 'invalid-hash' }),
    (error) => error.code === '23514',
  );
});
