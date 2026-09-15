const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');

const { LeaseStore, LeaseLostError } = source('apps/worker/src/ingestion/lease-store.ts');

const schema = `worker_lease_${randomUUID().replaceAll('-', '')}`;

let admin;
let pool;
let store;
let schemaCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
  }

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Worker lease tests require a local database.');
  }

  const { migrate } = await import('../scripts/database.mjs');

  admin = new Client({ connectionString: url });
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

  store = new LeaseStore(pool);
});

after(async () => {
  try {
    if (pool) await pool.end();
  } finally {
    if (admin) {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
});

async function fixture() {
  const accountId = randomUUID();
  const channelId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();

  await admin.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    accountId,
    'Worker lease test account',
  ]);

  await admin.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
    channelId,
    'Worker lease test channel',
  ]);

  await admin.query(
    `
      INSERT INTO youtube_channels(channel_id, youtube_channel_id)
      VALUES($1, $2)
    `,
    [channelId, `channel-${randomUUID()}`],
  );

  await admin.query(
    `
      INSERT INTO stream_sessions(id, channel_id, label, source)
      VALUES($1, $2, 'Worker lease test broadcast', 'YOUTUBE')
    `,
    [sessionId, channelId],
  );

  await admin.query(
    `
      INSERT INTO youtube_broadcasts(
        session_id, channel_id, youtube_broadcast_id, live_chat_id
      )
      VALUES($1, $2, $3, $4)
    `,
    [sessionId, channelId, `broadcast-${randomUUID()}`, `chat-${randomUUID()}`],
  );

  await admin.query(
    `
      INSERT INTO monitoring_runs(
        id, channel_id, session_id,
        requested_by_account_id, credential_account_id
      )
      VALUES($1, $2, $3, $4, $4)
    `,
    [runId, channelId, sessionId, accountId],
  );

  return { runId, sessionId };
}

async function expire(client, runId) {
  await client.query(
    `
      UPDATE monitoring_worker_leases
      SET
        acquired_at = '2020-01-01T00:00:00Z',
        heartbeat_at = '2020-01-01T00:00:01Z',
        expires_at = '2020-01-01T00:00:02Z'
      WHERE run_id = $1
    `,
    [runId],
  );
}

test('concurrent workers cannot claim the same run', async () => {
  const f = await fixture();

  const results = await Promise.all(
    Array.from({ length: 4 }, () => store.claim(f.runId, randomUUID())),
  );

  const claimed = results.filter(Boolean);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].generation, '1');
});

test('heartbeat preserves ownership and extends expiry', async () => {
  const f = await fixture();
  const lease = await store.claim(f.runId, randomUUID());
  assert.ok(lease);

  // Shorten the initial lease without waiting in the test.
  await admin.query(
    `
      UPDATE monitoring_worker_leases
      SET expires_at = heartbeat_at + interval '5 seconds'
      WHERE run_id = $1
    `,
    [f.runId],
  );

  const before = await admin.query(
    'SELECT expires_at FROM monitoring_worker_leases WHERE run_id = $1',
    [f.runId],
  );

  await store.heartbeat(lease);

  const after = await admin.query(
    `
      SELECT owner_id, generation::text, expires_at
      FROM monitoring_worker_leases
      WHERE run_id = $1
    `,
    [f.runId],
  );

  assert.equal(after.rows[0].owner_id, lease.owner_id);
  assert.equal(after.rows[0].generation, lease.generation);
  assert.ok(after.rows[0].expires_at > before.rows[0].expires_at);
});

test('takeover increments generation and rejects the previous worker', async () => {
  const f = await fixture();
  const oldLease = await store.claim(f.runId, randomUUID());
  assert.ok(oldLease);

  await expire(admin, f.runId);

  const newLease = await store.claim(f.runId, randomUUID());
  assert.ok(newLease);
  assert.equal(BigInt(newLease.generation), BigInt(oldLease.generation) + 1n);

  await assert.rejects(store.heartbeat(oldLease), LeaseLostError);
  await assert.rejects(store.release(oldLease), LeaseLostError);

  let called = false;
  await assert.rejects(
    store.withLease(oldLease, async () => {
      called = true;
    }),
    LeaseLostError,
  );
  assert.equal(called, false);

  await store.heartbeat(newLease);
});

test('release preserves generation and invalidates the released lease', async () => {
  const f = await fixture();
  const first = await store.claim(f.runId, randomUUID());
  assert.ok(first);

  await store.release(first);

  const second = await store.claim(f.runId, first.owner_id);
  assert.ok(second);
  assert.equal(BigInt(second.generation), BigInt(first.generation) + 1n);

  await assert.rejects(store.heartbeat(first), LeaseLostError);
});

test('expiry rolls back protected checkpoint writes', async () => {
  const f = await fixture();
  const lease = await store.claim(f.runId, randomUUID());
  assert.ok(lease);

  await assert.rejects(
    store.withLease(lease, async (client) => {
      await client.query(
        `
          INSERT INTO youtube_chat_checkpoints(session_id, next_page_token)
          VALUES($1, 'must-not-persist')
        `,
        [f.sessionId],
      );

      // Simulate expiry during the transaction without a wall-clock sleep.
      await expire(client, f.runId);
    }),
    LeaseLostError,
  );

  const result = await admin.query(
    'SELECT session_id FROM youtube_chat_checkpoints WHERE session_id = $1',
    [f.sessionId],
  );

  assert.equal(result.rows.length, 0);
});

test('terminal runs cannot be claimed or used for protected writes', async () => {
  const f = await fixture();
  const lease = await store.claim(f.runId, randomUUID());
  assert.ok(lease);

  await admin.query(
    `
      UPDATE monitoring_runs
      SET status = 'STOPPED', finished_at = clock_timestamp()
      WHERE id = $1
    `,
    [f.runId],
  );

  assert.equal(await store.claim(f.runId, randomUUID()), null);
  await assert.rejects(
    store.withLease(lease, async () => {}),
    LeaseLostError,
  );
});

test('STOPPING runs can be claimed for shutdown recovery', async () => {
  const f = await fixture();

  await admin.query(
    `
      UPDATE monitoring_runs
      SET status = 'STOPPING', stop_requested_at = clock_timestamp()
      WHERE id = $1
    `,
    [f.runId],
  );

  assert.ok(await store.claim(f.runId, randomUUID()));
});

test('expired ownership cannot be revived by heartbeat', async () => {
  const f = await fixture();
  const lease = await store.claim(f.runId, randomUUID());
  assert.ok(lease);

  await expire(admin, f.runId);

  await assert.rejects(store.heartbeat(lease), LeaseLostError);
  await assert.rejects(store.release(lease), LeaseLostError);
});
