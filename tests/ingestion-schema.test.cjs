const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const schema = `ingestion_${randomUUID().replaceAll('-', '')}`;

let client;
let migrate;
let schemaCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
  }

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Ingestion schema tests require a local database.');
  }

  ({ migrate } = await import('../scripts/database.mjs'));

  client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 3000,
  });

  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await client.query(`SET search_path TO ${schema}`);
  await migrate(client);
});

after(async () => {
  if (!client) return;

  try {
    if (schemaCreated) {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
    }
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
    'Ingestion test account',
  ]);

  await client.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
    channelId,
    'Ingestion test channel',
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
      VALUES($1, $2, 'Ingestion test broadcast', 'YOUTUBE')
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

test('ingestion migration can be applied repeatedly', async () => {
  await migrate(client);

  const result = await client.query('SELECT name FROM schema_migrations WHERE name = $1', [
    '005_youtube_ingestion_state.sql',
  ]);

  assert.equal(result.rows.length, 1);
});

test('leases require an existing run and allow only one record per run', async () => {
  await assert.rejects(
    client.query('INSERT INTO monitoring_worker_leases(run_id) VALUES($1)', [randomUUID()]),
    (error) => error.code === '23503',
  );

  const f = await fixture();

  await client.query('INSERT INTO monitoring_worker_leases(run_id) VALUES($1)', [f.runId]);

  await assert.rejects(
    client.query('INSERT INTO monitoring_worker_leases(run_id) VALUES($1)', [f.runId]),
    (error) => error.code === '23505',
  );
});

test('lease ownership requires a positive generation and consistent timestamps', async () => {
  const f = await fixture();

  await client.query('INSERT INTO monitoring_worker_leases(run_id) VALUES($1)', [f.runId]);

  await assert.rejects(
    client.query('UPDATE monitoring_worker_leases SET owner_id = $2 WHERE run_id = $1', [
      f.runId,
      randomUUID(),
    ]),
    (error) => error.code === '23514',
  );

  for (const [generation, acquired, heartbeat, expires] of [
    [0, '00:00:00', '00:00:01', '00:01:00'],
    [1, '00:00:02', '00:00:01', '00:01:00'],
    [1, '00:00:00', '00:00:01', '00:00:01'],
  ]) {
    await assert.rejects(
      client.query(
        `
          UPDATE monitoring_worker_leases
          SET
            owner_id = $2,
            generation = $3,
            acquired_at = $4,
            heartbeat_at = $5,
            expires_at = $6
          WHERE run_id = $1
        `,
        [
          f.runId,
          randomUUID(),
          generation,
          `2026-01-01T${acquired}Z`,
          `2026-01-01T${heartbeat}Z`,
          `2026-01-01T${expires}Z`,
        ],
      ),
      (error) => error.code === '23514',
    );
  }
});

test('releasing a lease can preserve its generation', async () => {
  const f = await fixture();

  await client.query(
    `
      INSERT INTO monitoring_worker_leases(
        run_id, generation, owner_id,
        acquired_at, heartbeat_at, expires_at
      )
      VALUES(
        $1, 1, $2,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:01Z',
        '2026-01-01T00:01:00Z'
      )
    `,
    [f.runId, randomUUID()],
  );

  await client.query(
    `
      UPDATE monitoring_worker_leases
      SET
        owner_id = NULL,
        acquired_at = NULL,
        heartbeat_at = NULL,
        expires_at = NULL
      WHERE run_id = $1
    `,
    [f.runId],
  );

  const result = await client.query(
    'SELECT generation, owner_id FROM monitoring_worker_leases WHERE run_id = $1',
    [f.runId],
  );

  assert.equal(String(result.rows[0].generation), '1');
  assert.equal(result.rows[0].owner_id, null);
});

test('checkpoints require a YouTube broadcast and reject invalid values', async () => {
  await assert.rejects(
    client.query('INSERT INTO youtube_chat_checkpoints(session_id) VALUES($1)', [randomUUID()]),
    (error) => error.code === '23503',
  );

  const f = await fixture();

  await client.query('INSERT INTO youtube_chat_checkpoints(session_id) VALUES($1)', [f.sessionId]);

  await assert.rejects(
    client.query('INSERT INTO youtube_chat_checkpoints(session_id) VALUES($1)', [f.sessionId]),
    (error) => error.code === '23505',
  );

  await assert.rejects(
    client.query("UPDATE youtube_chat_checkpoints SET next_page_token = '' WHERE session_id = $1", [
      f.sessionId,
    ]),
    (error) => error.code === '23514',
  );

  await assert.rejects(
    client.query(
      `
        UPDATE youtube_chat_checkpoints
        SET consecutive_failures = -1
        WHERE session_id = $1
      `,
      [f.sessionId],
    ),
    (error) => error.code === '23514',
  );
});

test('a monitoring restart retains the session checkpoint', async () => {
  const f = await fixture();

  await client.query(
    `
      INSERT INTO youtube_chat_checkpoints(session_id, next_page_token)
      VALUES($1, 'opaque-test-token')
    `,
    [f.sessionId],
  );

  await client.query(
    `
      UPDATE monitoring_runs
      SET status = 'STOPPED', finished_at = clock_timestamp()
      WHERE id = $1
    `,
    [f.runId],
  );

  const nextRunId = randomUUID();

  await client.query(
    `
      INSERT INTO monitoring_runs(
        id, channel_id, session_id,
        requested_by_account_id, credential_account_id
      )
      VALUES($1, $2, $3, $4, $4)
    `,
    [nextRunId, f.channelId, f.sessionId, f.accountId],
  );

  const result = await client.query(
    `
      SELECT checkpoint.next_page_token
      FROM monitoring_runs run
      JOIN youtube_chat_checkpoints checkpoint
        ON checkpoint.session_id = run.session_id
      WHERE run.id = $1
    `,
    [nextRunId],
  );

  assert.equal(result.rows[0].next_page_token, 'opaque-test-token');
});
