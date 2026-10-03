const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');

const { MonitoringService } = source('apps/api/src/monitoring/monitoring.service.ts');
const { ModerationSettingsStore } = source('apps/api/src/settings/moderation-settings-store.ts');

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

  const snapshots = await pool.query(
    'SELECT run_id FROM monitoring_settings_snapshots WHERE run_id = $1',
    [results[0].run.id],
  );
  assert.equal(snapshots.rows.length, 1);
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

async function readSnapshot(runId) {
  const result = await pool.query(
    `SELECT run_id, channel_id, settings_id, settings_revision, configuration, source
     FROM monitoring_settings_snapshots WHERE run_id = $1`,
    [runId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function finishRun(runId) {
  await pool.query(
    "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
    [runId],
  );
}

test('settings changes affect new run snapshots, never active reuse or old-key replay', async () => {
  const f = await fixture();
  const firstKey = randomUUID();
  const first = await f.start(firstKey);
  const fallback = {
    schema_version: 1,
    automatic_actions_enabled: false,
    rules: [],
  };
  const initial = await readSnapshot(first.run.id);
  assert.deepEqual(initial, {
    run_id: first.run.id,
    channel_id: first.run.channel_id,
    settings_id: null,
    settings_revision: null,
    configuration: fallback,
    source: 'DEFAULT',
  });

  const store = new ModerationSettingsStore(pool);
  const configuration = {
    schema_version: 1,
    automatic_actions_enabled: true,
    rules: [
      {
        rule_id: 'id.harassment.direct-insult',
        rule_version: '1',
        minimum_severity: 2,
        action: 'TIMEOUT',
        duration_seconds: 30,
      },
    ],
  };
  const revisionOne = await store.save(first.run.channel_id, f.accountId, {
    expected_revision: 0,
    configuration,
  });

  assert.equal((await f.start()).run.id, first.run.id);
  assert.deepEqual(await readSnapshot(first.run.id), initial);
  await finishRun(first.run.id);
  assert.equal((await f.start(firstKey)).run.id, first.run.id);
  assert.deepEqual(await readSnapshot(first.run.id), initial);

  const secondKey = randomUUID();
  const second = await f.start(secondKey);
  const selected = await readSnapshot(second.run.id);
  assert.deepEqual(selected, {
    run_id: second.run.id,
    channel_id: second.run.channel_id,
    settings_id: revisionOne.id,
    settings_revision: 1,
    configuration,
    source: 'SAVED',
  });

  const revisionTwo = await store.save(first.run.channel_id, f.accountId, {
    expected_revision: 1,
    configuration: fallback,
  });
  assert.equal((await f.start()).run.id, second.run.id);
  assert.deepEqual(await readSnapshot(second.run.id), selected);
  await finishRun(second.run.id);
  assert.equal((await f.start(secondKey)).run.id, second.run.id);
  assert.deepEqual(await readSnapshot(second.run.id), selected);

  const third = await f.start();
  const latest = await readSnapshot(third.run.id);
  assert.equal(latest.settings_id, revisionTwo.id);
  assert.equal(latest.settings_revision, 2);
  assert.equal(latest.source, 'SAVED');
  assert.deepEqual(latest.configuration, fallback);

  const other = await fixture();
  const unrelated = await other.start();
  assert.equal((await readSnapshot(unrelated.run.id)).source, 'DEFAULT');
});

test('snapshots are immutable, unique per run, and cannot reference a missing run', async () => {
  const f = await fixture();
  const started = await f.start();
  for (const sql of [
    "UPDATE monitoring_settings_snapshots SET source = 'LEGACY' WHERE run_id = $1",
    'DELETE FROM monitoring_settings_snapshots WHERE run_id = $1',
  ]) {
    await assert.rejects(pool.query(sql, [started.run.id]), (error) => error.code === '23514');
  }

  const config = JSON.stringify({
    schema_version: 1,
    automatic_actions_enabled: false,
    rules: [],
  });
  await assert.rejects(
    pool.query(
      `INSERT INTO monitoring_settings_snapshots(run_id, channel_id, configuration, source)
     VALUES ($1, $2, $3::jsonb, 'DEFAULT')`,
      [started.run.id, started.run.channel_id, config],
    ),
    (error) => error.code === '23505',
  );

  const other = await fixture();
  const otherRun = await other.start();
  await assert.rejects(
    pool.query(
      `INSERT INTO monitoring_settings_snapshots(run_id, channel_id, configuration, source)
     VALUES ($1, $2, $3::jsonb, 'DEFAULT')`,
      [randomUUID(), otherRun.run.channel_id, config],
    ),
    (error) => error.code === '23503',
  );
});

test('saved snapshot metadata must match its referenced channel settings', async () => {
  const f = await fixture();
  const started = await f.start();
  const store = new ModerationSettingsStore(pool);
  const configuration = {
    schema_version: 1,
    automatic_actions_enabled: false,
    rules: [],
  };
  const settings = await store.save(started.run.channel_id, f.accountId, {
    expected_revision: 0,
    configuration,
  });
  const other = await fixture();
  const otherRun = await other.start();

  for (const [channelId, revision, config] of [
    [started.run.channel_id, 2, configuration],
    [started.run.channel_id, 1, { ...configuration, automatic_actions_enabled: true }],
    [otherRun.run.channel_id, 1, configuration],
  ]) {
    await assert.rejects(
      pool.query(
        `INSERT INTO monitoring_settings_snapshots (
        run_id, channel_id, settings_id, settings_revision, configuration, source
      ) VALUES ($1, $2, $3, $4, $5::jsonb, 'SAVED')`,
        [randomUUID(), channelId, settings.id, revision, JSON.stringify(config)],
      ),
      (error) => error.code === '23514',
    );
  }

  await assert.rejects(
    pool.query(
      `INSERT INTO monitoring_settings_snapshots(run_id, channel_id, configuration, source)
     VALUES ($1, $2, $3::jsonb, 'LEGACY')`,
      [randomUUID(), started.run.channel_id, JSON.stringify(configuration)],
    ),
    (error) => error.code === '23514',
  );
});

test('rolling back run creation also removes its automatically captured snapshot', async () => {
  const f = await fixture();
  const started = await f.start();
  await finishRun(started.run.id);
  const runId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO monitoring_runs (
        id, channel_id, session_id, requested_by_account_id, credential_account_id, status
      ) VALUES ($1, $2, $3, $4, $4, 'STARTING')`,
      [runId, started.run.channel_id, started.run.session_id, f.accountId],
    );
    const inside = await client.query(
      'SELECT run_id FROM monitoring_settings_snapshots WHERE run_id = $1',
      [runId],
    );
    assert.equal(inside.rows.length, 1);
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
  assert.equal(
    (await pool.query('SELECT id FROM monitoring_runs WHERE id = $1', [runId])).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query('SELECT run_id FROM monitoring_settings_snapshots WHERE run_id = $1', [
        runId,
      ])
    ).rowCount,
    0,
  );
});
