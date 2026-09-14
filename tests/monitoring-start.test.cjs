const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');

const { MonitoringService } = source('apps/api/src/monitoring/monitoring.service.ts');

const schema = `monitoring_start_${randomUUID().replaceAll('-', '')}`;

let admin;
let pool;
let schemaCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
  }

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Monitoring start tests require a local database.');
  }

  const { migrate } = await import('../scripts/database.mjs');

  admin = new Client({
    connectionString: url,
    connectionTimeoutMillis: 3000,
  });

  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;

  await admin.query(`SET search_path TO ${schema}`);
  await migrate(admin);

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
    if (admin) {
      try {
        if (schemaCreated) {
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        }
      } finally {
        await admin.end();
      }
    }
  }
});

async function fixture() {
  const accountId = randomUUID();
  const verified = Object.freeze({
    youtube_broadcast_id: `broadcast-${randomUUID()}`,
    youtube_channel_id: `channel-${randomUUID()}`,
    channel_title: 'Test channel',
    title: 'Test livestream',
    live_chat_id: `chat-${randomUUID()}`,
  });

  await pool.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    accountId,
    'Monitoring start test account',
  ]);

  let verificationCalls = 0;
  let verificationError = null;

  const service = new MonitoringService(
    { pool },
    {
      async verifyBroadcast(actorId, broadcastId) {
        verificationCalls++;
        assert.equal(actorId, accountId);
        assert.equal(broadcastId, verified.youtube_broadcast_id);

        if (verificationError) throw verificationError;

        return verified;
      },
    },
  );

  return {
    accountId,
    verified,
    service,
    start(key = randomUUID()) {
      return service.start(accountId, key, {
        youtube_broadcast_id: verified.youtube_broadcast_id,
      });
    },
    get verificationCalls() {
      return verificationCalls;
    },
    failVerification(error) {
      verificationError = error;
    },
  };
}

test('start creates a STARTING run using the authenticated account credentials', async () => {
  const f = await fixture();
  const result = await f.start();

  assert.equal(result.reused, false);
  assert.equal(result.run.status, 'STARTING');
  assert.equal(result.run.started_at, null);
  assert.equal(result.run.finished_at, null);

  const stored = await pool.query(
    `
      SELECT requested_by_account_id, credential_account_id
      FROM monitoring_runs
      WHERE id = $1
    `,
    [result.run.id],
  );

  assert.deepEqual(stored.rows[0], {
    requested_by_account_id: f.accountId,
    credential_account_id: f.accountId,
  });

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('credential_account_id'), false);
  assert.equal(serialized.includes(f.verified.live_chat_id), false);
});

test('concurrent requests with the same key create one run and one request record', async () => {
  const f = await fixture();
  const key = randomUUID();

  const results = await Promise.all(Array.from({ length: 4 }, () => f.start(key)));

  assert.equal(new Set(results.map((result) => result.run.id)).size, 1);
  assert.equal(results.filter((result) => !result.reused).length, 1);

  const requests = await pool.query(
    'SELECT request_key FROM monitoring_start_requests WHERE account_id = $1',
    [f.accountId],
  );

  assert.equal(requests.rows.length, 1);
});

test('different keys reuse an active run and each retain their request mapping', async () => {
  const f = await fixture();

  const results = await Promise.all(Array.from({ length: 4 }, () => f.start()));

  assert.equal(new Set(results.map((result) => result.run.id)).size, 1);
  assert.equal(results.filter((result) => !result.reused).length, 1);

  const requests = await pool.query(
    'SELECT request_key FROM monitoring_start_requests WHERE account_id = $1',
    [f.accountId],
  );

  assert.equal(requests.rows.length, 4);
});

test('a key cannot be reused for another broadcast', async () => {
  const f = await fixture();
  const key = randomUUID();

  await f.start(key);
  const calls = f.verificationCalls;

  await assert.rejects(
    f.service.start(f.accountId, key, {
      youtube_broadcast_id: 'another-broadcast',
    }),
    (error) => {
      assert.equal(error.getStatus(), 409);
      assert.equal(error.getResponse().code, 'IDEMPOTENCY_KEY_CONFLICT');
      return true;
    },
  );

  assert.equal(f.verificationCalls, calls);
});

test('an old key replays a terminal run while a new key creates a new run', async () => {
  const f = await fixture();
  const key = randomUUID();
  const first = await f.start(key);

  await pool.query(
    `
      UPDATE monitoring_runs
      SET status = 'STOPPED', finished_at = clock_timestamp()
      WHERE id = $1
    `,
    [first.run.id],
  );

  const calls = f.verificationCalls;
  const replay = await f.start(key);

  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.run.status, 'STOPPED');
  assert.equal(replay.reused, true);
  assert.equal(f.verificationCalls, calls);

  const restarted = await f.start();

  assert.notEqual(restarted.run.id, first.run.id);
  assert.equal(restarted.run.session_id, first.run.session_id);
  assert.equal(restarted.run.status, 'STARTING');
  assert.equal(restarted.reused, false);
});

test('failed Google verification creates no channel mapping or start request', async () => {
  const f = await fixture();
  const error = new Error('Verification failed');
  f.failVerification(error);

  await assert.rejects(f.start(), (received) => received === error);

  const mappings = await pool.query(
    'SELECT channel_id FROM youtube_channels WHERE youtube_channel_id = $1',
    [f.verified.youtube_channel_id],
  );

  const requests = await pool.query(
    'SELECT request_key FROM monitoring_start_requests WHERE account_id = $1',
    [f.accountId],
  );

  assert.equal(mappings.rows.length, 0);
  assert.equal(requests.rows.length, 0);
});

test('revoked membership prevents replay of a previous start request', async () => {
  const f = await fixture();
  const key = randomUUID();
  const first = await f.start(key);

  await pool.query('DELETE FROM channel_memberships WHERE channel_id = $1 AND account_id = $2', [
    first.run.channel_id,
    f.accountId,
  ]);

  const calls = f.verificationCalls;

  await assert.rejects(f.start(key), (error) => {
    assert.equal(error.getStatus(), 403);
    assert.equal(error.getResponse().code, 'CHANNEL_FORBIDDEN');
    return true;
  });

  assert.equal(f.verificationCalls, calls);
});

test('invalid input is rejected before Google verification', async () => {
  const f = await fixture();

  for (const [key, body] of [
    ['invalid-key', { youtube_broadcast_id: f.verified.youtube_broadcast_id }],
    [
      randomUUID(),
      {
        youtube_broadcast_id: f.verified.youtube_broadcast_id,
        credential_account_id: randomUUID(),
      },
    ],
  ]) {
    await assert.rejects(
      f.service.start(f.accountId, key, body),
      (error) => error.getStatus() === 422,
    );
  }

  assert.equal(f.verificationCalls, 0);
});
