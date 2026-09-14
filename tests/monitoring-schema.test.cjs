const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const schema = `monitoring_${randomUUID().replaceAll('-', '')}`;

let client;
let migrate;
let schemaCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
  }

  const host = new URL(url).hostname;

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error('Monitoring schema tests require a local database.');
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

async function createFixture(source = 'YOUTUBE') {
  const accountId = randomUUID();
  const channelId = randomUUID();
  const sessionId = randomUUID();

  await client.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    accountId,
    'Monitoring test account',
  ]);

  await client.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
    channelId,
    'Monitoring test channel',
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
      VALUES($1, $2, $3, $4)
    `,
    [sessionId, channelId, 'Monitoring test broadcast', source],
  );

  return { accountId, channelId, sessionId };
}

async function attachBroadcast(fixture, externalId = randomUUID()) {
  await client.query(
    `
      INSERT INTO youtube_broadcasts(
        session_id,
        channel_id,
        youtube_broadcast_id,
        live_chat_id
      )
      VALUES($1, $2, $3, $4)
    `,
    [fixture.sessionId, fixture.channelId, externalId, `chat-${randomUUID()}`],
  );
}

async function createRun(fixture, status = 'STARTING') {
  const runId = randomUUID();

  await client.query(
    `
      INSERT INTO monitoring_runs(
        id,
        channel_id,
        session_id,
        requested_by_account_id,
        credential_account_id,
        status
      )
      VALUES($1, $2, $3, $4, $4, $5)
    `,
    [runId, fixture.channelId, fixture.sessionId, fixture.accountId, status],
  );

  return runId;
}

test('migrations can be applied repeatedly', async () => {
  await migrate(client);

  const result = await client.query('SELECT name FROM schema_migrations WHERE name=$1', [
    '004_youtube_monitoring.sql',
  ]);

  assert.equal(result.rows.length, 1);
});

test('a synthetic session cannot be registered as a YouTube broadcast', async () => {
  const fixture = await createFixture('SYNTHETIC');

  await assert.rejects(attachBroadcast(fixture), (error) => error.code === '23503');
});

test('a broadcast cannot reference a session from another channel', async () => {
  const first = await createFixture();
  const second = await createFixture();

  await assert.rejects(
    attachBroadcast({
      ...first,
      channelId: second.channelId,
    }),
    (error) => error.code === '23503',
  );
});

test('the same YouTube broadcast cannot create duplicate history sessions', async () => {
  const first = await createFixture();
  const second = await createFixture();
  const broadcastId = randomUUID();

  await attachBroadcast(first, broadcastId);

  await assert.rejects(attachBroadcast(second, broadcastId), (error) => error.code === '23505');
});

test('only one active run is allowed, but a stopped broadcast can restart', async () => {
  const fixture = await createFixture();

  await attachBroadcast(fixture);

  const firstRun = await createRun(fixture);

  await assert.rejects(createRun(fixture), (error) => error.code === '23505');

  await client.query(
    `
      UPDATE monitoring_runs
      SET status='STOPPED', finished_at=clock_timestamp()
      WHERE id=$1
    `,
    [firstRun],
  );

  const secondRun = await createRun(fixture);

  assert.notEqual(firstRun, secondRun);

  const result = await client.query('SELECT id FROM monitoring_runs WHERE session_id=$1', [
    fixture.sessionId,
  ]);

  assert.equal(result.rows.length, 2);
});

test('running and terminal states require their timestamps', async () => {
  const fixture = await createFixture();

  await attachBroadcast(fixture);

  await assert.rejects(createRun(fixture, 'RUNNING'), (error) => error.code === '23514');

  await assert.rejects(createRun(fixture, 'STOPPED'), (error) => error.code === '23514');
});

test('start request keys are unique per account', async () => {
  const fixture = await createFixture();

  await attachBroadcast(fixture);

  const runId = await createRun(fixture);
  const requestKey = randomUUID();

  const insert = () =>
    client.query(
      `
        INSERT INTO monitoring_start_requests(
          account_id,
          request_key,
          monitoring_run_id
        )
        VALUES($1, $2, $3)
      `,
      [fixture.accountId, requestKey, runId],
    );

  await insert();

  await assert.rejects(insert(), (error) => error.code === '23505');
});
