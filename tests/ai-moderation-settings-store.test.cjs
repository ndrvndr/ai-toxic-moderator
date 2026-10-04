const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFile, readdir } = require('node:fs/promises');
const path = require('node:path');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');

const { AiModerationSettingsStore, AiModerationSettingsConflict } = source(
  'apps/api/src/settings/ai-moderation-settings-store.ts',
);
const { aiModerationSettingsSnapshot } = source('packages/contracts/src/ai-moderation-settings.ts');
const schema = `ai_settings_${randomUUID().replaceAll('-', '')}`;
const apiRole = `ai_settings_api_${randomUUID().replaceAll('-', '')}`;
const workerRole = `ai_settings_worker_${randomUUID().replaceAll('-', '')}`;

let admin;
let pool;
let worker;
let store;
let migrate;
let schemaCreated = false;
let apiRoleCreated = false;
let workerRoleCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Set TEST_DATABASE_URL to an admin-capable local test database.');
  }
  ({ migrate } = await import('../scripts/database.mjs'));
  const { provisionRuntimeRole } = await import('../scripts/runtime-role.mjs');
  const { provisionWorkerRole } = await import('../scripts/worker-role.mjs');
  admin = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await admin.query(`SET search_path TO ${schema}`);
  await migrate(admin);
  await provisionRuntimeRole(admin, { role: apiRole, password: randomUUID(), schema });
  apiRoleCreated = true;
  await provisionWorkerRole(admin, { role: workerRole, password: randomUUID(), schema });
  workerRoleCreated = true;
  pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${apiRole}`,
    max: 4,
    statement_timeout: 10000,
    connectionTimeoutMillis: 3000,
  });
  worker = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${workerRole}`,
    max: 2,
    statement_timeout: 10000,
    connectionTimeoutMillis: 3000,
  });
  store = new AiModerationSettingsStore(pool);
});

after(async () => {
  try {
    if (pool) await pool.end();
    if (worker) await worker.end();
  } finally {
    if (admin) {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        if (apiRoleCreated) await admin.query(`DROP ROLE ${apiRole}`);
        if (workerRoleCreated) await admin.query(`DROP ROLE ${workerRole}`);
      } finally {
        await admin.end();
      }
    }
  }
});

async function fixture(connection = admin) {
  const f = { channelId: randomUUID(), accountId: randomUUID(), sessionId: randomUUID() };
  await connection.query('INSERT INTO accounts(id, display_name) VALUES ($1, $2)', [
    f.accountId,
    'AI settings test owner',
  ]);
  await connection.query('INSERT INTO channels(id, display_name) VALUES ($1, $2)', [
    f.channelId,
    'AI settings test channel',
  ]);
  await connection.query(
    "INSERT INTO channel_memberships(channel_id, account_id, role) VALUES ($1, $2, 'OWNER')",
    [f.channelId, f.accountId],
  );
  await connection.query(
    'INSERT INTO youtube_channels(channel_id, youtube_channel_id) VALUES ($1, $2)',
    [f.channelId, `channel-${randomUUID()}`],
  );
  await connection.query(
    "INSERT INTO stream_sessions(id, channel_id, label, source) VALUES ($1, $2, $3, 'YOUTUBE')",
    [f.sessionId, f.channelId, 'AI settings test broadcast'],
  );
  await connection.query(
    `INSERT INTO youtube_broadcasts(session_id, channel_id, youtube_broadcast_id, live_chat_id)
     VALUES ($1, $2, $3, $4)`,
    [f.sessionId, f.channelId, `broadcast-${randomUUID()}`, `chat-${randomUUID()}`],
  );
  return f;
}

async function requireOwner(client, f) {
  const result = await client.query(
    'SELECT role FROM channel_memberships WHERE channel_id = $1 AND account_id = $2 FOR SHARE',
    [f.channelId.toLowerCase(), f.accountId.toLowerCase()],
  );
  if (result.rows[0]?.role !== 'OWNER') throw new Error('AI settings access revoked');
}

function save(f, expected_revision, value = configuration()) {
  return store.save(
    f.channelId,
    f.accountId,
    { expected_revision, configuration: value },
    (client) => requireOwner(client, f),
  );
}

async function start(f, connection = pool) {
  const id = randomUUID();
  await connection.query(
    `INSERT INTO monitoring_runs(id, channel_id, session_id, requested_by_account_id, credential_account_id)
     VALUES ($1, $2, $3, $4, $4)`,
    [id, f.channelId, f.sessionId, f.accountId],
  );
  return id;
}

function finish(id, connection = admin) {
  return connection.query(
    "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
    [id],
  );
}

async function snapshot(id, connection = pool) {
  const result = await connection.query(
    `SELECT run_id, channel_id, settings_id, settings_revision, configuration, source
     FROM monitoring_ai_settings_snapshots WHERE run_id = $1`,
    [id],
  );
  assert.equal(result.rows.length, 1);
  return aiModerationSettingsSnapshot.parse(result.rows[0]);
}

function configuration(enabled = false) {
  return {
    schema_version: 1,
    automatic_actions_enabled: enabled,
    model: {
      model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
      model_revision: '0e011be8ba6aca297059e7ab1a07d4f11054e653',
      model_variant: 'INT8',
      adapter_version: 'laskar-shadow-1',
    },
    score_metric: 'EXPECTED_SEVERITY',
    delete: { enabled: true, threshold: 0.6 },
    timeout: { enabled: true, threshold: 0.8, duration_seconds: 30 },
    ban: { enabled: false, threshold: 0.95 },
  };
}

test('migration is repeatable and API writes retain immutable per-channel revisions', async () => {
  await migrate(admin);
  const f = await fixture();
  assert.equal(await store.getLatest(f.channelId), null);
  const first = await save(f, 0);
  const second = await save(f, 1, configuration(true));
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.notEqual(first.id, second.id);
  assert.equal(first.created_by, f.accountId);
  assert.deepEqual(await store.getLatest(f.channelId.toUpperCase()), second);
  const history = await admin.query(
    'SELECT configuration FROM channel_ai_moderation_settings WHERE id = $1',
    [first.id],
  );
  assert.deepEqual(history.rows[0].configuration, first.configuration);
  const other = await fixture();
  assert.equal(await store.getLatest(other.channelId), null);
  assert.equal((await save(other, 0)).revision, 1);
});

test('competing saves create one revision and report the current revision to the loser', async () => {
  const f = await fixture();
  for (const expected of [0, 1]) {
    const results = await Promise.allSettled([
      save(f, expected),
      save({ ...f, channelId: f.channelId.toUpperCase() }, expected),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(winners[0].value.revision, expected + 1);
    assert.ok(losers[0].reason instanceof AiModerationSettingsConflict);
    assert.equal(losers[0].reason.currentRevision, expected + 1);
  }
  assert.equal((await store.getLatest(f.channelId)).revision, 2);
});

test('invalid settings and failed authorization do not consume a revision', async () => {
  const f = await fixture();
  const invalid = configuration();
  invalid.timeout.threshold = invalid.delete.threshold;
  await assert.rejects(save(f, 0, invalid), (error) => error.name === 'ZodError');
  await assert.rejects(
    store.save(
      f.channelId,
      f.accountId,
      {
        expected_revision: 0,
        configuration: configuration(),
      },
      async () => {
        throw new Error('AI settings access revoked');
      },
    ),
    /AI settings access revoked/,
  );
  assert.equal(await store.getLatest(f.channelId), null);
  assert.equal((await save(f, 0)).revision, 1);
});

test('ownership is checked after waiting for the settings revision lock', async () => {
  const f = await fixture();
  const blocker = await pool.connect();
  let locked = false;
  let waiting;
  try {
    await blocker.query('BEGIN');
    locked = true;
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `ai-moderation-settings:${f.channelId}`,
    ]);
    waiting = save(f, 0).then(
      () => ({ saved: true }),
      (error) => ({ saved: false, error }),
    );
    await admin.query(
      "UPDATE channel_memberships SET role = 'MODERATOR' WHERE channel_id = $1 AND account_id = $2",
      [f.channelId, f.accountId],
    );
    await blocker.query('COMMIT');
    locked = false;
    const result = await waiting;
    assert.equal(result.saved, false);
    assert.equal(result.error.message, 'AI settings access revoked');
    assert.equal(await store.getLatest(f.channelId), null);
  } finally {
    if (locked) await blocker.query('ROLLBACK');
    blocker.release();
    if (waiting) await waiting;
  }
});

test('new runs capture saved AI policy while active and previous runs retain their snapshot', async () => {
  const f = await fixture();
  const first = await start(f);
  const original = await snapshot(first);
  assert.deepEqual(original, {
    run_id: first,
    channel_id: f.channelId,
    settings_id: null,
    settings_revision: null,
    configuration: null,
    source: 'DEFAULT',
  });
  const one = await save(f, 0, configuration(true));
  assert.deepEqual(await snapshot(first), original);
  await finish(first);
  const second = await start(f);
  const selected = await snapshot(second);
  assert.equal(selected.settings_id, one.id);
  assert.equal(selected.settings_revision, 1);
  assert.equal(selected.source, 'SAVED');
  assert.deepEqual(selected.configuration, one.configuration);
  const two = await save(f, 1, configuration(false));
  assert.deepEqual(await snapshot(second), selected);
  await finish(second);
  const third = await start(f);
  assert.equal((await snapshot(third)).settings_id, two.id);
  assert.equal((await snapshot(third)).configuration.automatic_actions_enabled, false);
  assert.deepEqual(await snapshot(second), selected);
});

test('run creation captures committed settings without waiting for an uncommitted newer revision', async () => {
  const f = await fixture();
  const first = await save(f, 0);
  const writer = await pool.connect();
  let writing = false;
  try {
    await writer.query('BEGIN');
    writing = true;
    await writer.query(
      `INSERT INTO channel_ai_moderation_settings(id, channel_id, revision, configuration, created_by)
       VALUES ($1, $2, 2, $3::jsonb, $4)`,
      [randomUUID(), f.channelId, JSON.stringify(configuration(true)), f.accountId],
    );
    const run = await start(f);
    assert.equal((await snapshot(run)).settings_id, first.id);
    await writer.query('COMMIT');
    writing = false;
    assert.equal((await snapshot(run)).settings_revision, 1);
    await finish(run);
    assert.equal((await snapshot(await start(f))).settings_revision, 2);
  } finally {
    if (writing) await writer.query('ROLLBACK');
    writer.release();
  }
});

test('rolling back run creation removes AI, blacklist, and rule settings snapshots together', async () => {
  const f = await fixture();
  await save(f, 0, configuration(true));
  const client = await pool.connect();
  let run;
  try {
    await client.query('BEGIN');
    run = await start(f, client);
    assert.equal((await snapshot(run, client)).source, 'SAVED');
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
  assert.equal(
    (await pool.query('SELECT id FROM monitoring_runs WHERE id = $1', [run])).rowCount,
    0,
  );
  for (const table of [
    'monitoring_ai_settings_snapshots',
    'monitoring_blacklist_snapshots',
    'monitoring_settings_snapshots',
  ]) {
    assert.equal(
      (await pool.query(`SELECT run_id FROM ${table} WHERE run_id = $1`, [run])).rowCount,
      0,
    );
  }
});

test('snapshot validation rejects forged settings, foreign channels, and reserved legacy source', async () => {
  const f = await fixture();
  const settings = await save(f, 0, configuration(true));
  const other = await fixture();
  // A valid saved revision from another channel must not satisfy the snapshot check.
  for (const [channel, revision, config] of [
    [other.channelId, 1, settings.configuration],
    [f.channelId, 2, settings.configuration],
    [f.channelId, 1, configuration(false)],
  ]) {
    await assert.rejects(
      admin.query(
        `INSERT INTO monitoring_ai_settings_snapshots(run_id, channel_id, settings_id, settings_revision, configuration, source)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'SAVED')`,
        [randomUUID(), channel, settings.id, revision, JSON.stringify(config)],
      ),
      { code: '23514' },
    );
  }
  await assert.rejects(
    admin.query(
      "INSERT INTO monitoring_ai_settings_snapshots(run_id, channel_id, source) VALUES ($1, $2, 'LEGACY')",
      [randomUUID(), f.channelId],
    ),
    { code: '23514' },
  );
  for (const config of [configuration(), null]) {
    // JSON null is not SQL NULL and must not masquerade as an absent policy.
    await assert.rejects(
      admin.query(
        "INSERT INTO monitoring_ai_settings_snapshots(run_id, channel_id, source, configuration) VALUES ($1, $2, 'DEFAULT', $3::jsonb)",
        [randomUUID(), f.channelId, JSON.stringify(config)],
      ),
      { code: '23514' },
    );
  }
  await assert.rejects(
    admin.query(
      "INSERT INTO monitoring_ai_settings_snapshots(run_id, channel_id, source) VALUES ($1, $2, 'DEFAULT')",
      [randomUUID(), f.channelId],
    ),
    { code: '23503' },
  );
  const run = await start(f);
  await assert.rejects(
    admin.query(
      "INSERT INTO monitoring_ai_settings_snapshots(run_id, channel_id, source) VALUES ($1, $2, 'DEFAULT')",
      [run, f.channelId],
    ),
    { code: '23505' },
  );
});

test('database validation rejects malformed settings even when the store is bypassed', async () => {
  const f = await fixture();
  const insert = (revision, value) =>
    admin.query(
      `INSERT INTO channel_ai_moderation_settings(id, channel_id, revision, configuration, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [randomUUID(), f.channelId, revision, JSON.stringify(value), f.accountId],
    );
  for (const revision of [0, 2])
    await assert.rejects(insert(revision, configuration()), { code: '23514' });
  for (const value of [
    {},
    [],
    null,
    { ...configuration(), automatic_actions_enabled: 'false' },
    { ...configuration(), schema_version: 2 },
    { ...configuration(), unexpected: true },
    { ...configuration(), score_metric: 'PROBABILITY' },
    { ...configuration(), model: { ...configuration().model, model_revision: 'main' } },
    { ...configuration(), model: { ...configuration().model, model_variant: 'FP32' } },
    { ...configuration(), model: null },
    { ...configuration(), model: { ...configuration().model, adapter_version: '' } },
    { ...configuration(), delete: { enabled: true, threshold: -1 } },
    { ...configuration(), delete: { enabled: 'true', threshold: 0.6 } },
    { ...configuration(), delete: { enabled: true, threshold: '0.6' } },
    { ...configuration(), delete: { enabled: true, threshold: 0.8 } },
    { ...configuration(), timeout: { enabled: true, threshold: 0.95, duration_seconds: 30 } },
    { ...configuration(), timeout: { ...configuration().timeout, duration_seconds: 0 } },
    { ...configuration(), timeout: { ...configuration().timeout, duration_seconds: 1.5 } },
    { ...configuration(), timeout: { ...configuration().timeout, duration_seconds: '30' } },
    { ...configuration(), timeout: { ...configuration().timeout, duration_seconds: 86401 } },
    { ...configuration(), timeout: { enabled: true, threshold: 0.8 } },
    { ...configuration(), ban: { enabled: false, threshold: 1.01 } },
    { ...configuration(), ban: { ...configuration().ban, duration_seconds: 30 } },
  ]) {
    await assert.rejects(insert(1, value), { code: '23514' });
  }
  assert.equal((await save(f, 0)).revision, 1);
});

test('histories remain immutable and workers can read snapshots but cannot change policies', async () => {
  const f = await fixture();
  const saved = await save(f, 0);
  const run = await start(f);
  assert.deepEqual((await snapshot(run, worker)).configuration, saved.configuration);
  for (const [table, key, id] of [
    ['channel_ai_moderation_settings', 'id', saved.id],
    ['monitoring_ai_settings_snapshots', 'run_id', run],
  ]) {
    for (const sql of [
      `UPDATE ${table} SET configuration = configuration WHERE ${key} = $1`,
      `DELETE FROM ${table} WHERE ${key} = $1`,
    ]) {
      await assert.rejects(admin.query(sql, [id]), { code: '23514' });
      await assert.rejects(pool.query(sql, [id]), { code: '42501' });
      await assert.rejects(worker.query(sql, [id]), { code: '42501' });
    }
    await assert.rejects(pool.query(`TRUNCATE ${table}`), { code: '42501' });
    await assert.rejects(worker.query(`TRUNCATE ${table}`), { code: '42501' });
  }
  await assert.rejects(worker.query('SELECT id FROM channel_ai_moderation_settings LIMIT 0'), {
    code: '42501',
  });
  await assert.rejects(
    worker.query(
      `INSERT INTO channel_ai_moderation_settings(id, channel_id, revision, configuration, created_by)
     VALUES ($1, $2, 2, $3::jsonb, $4)`,
      [randomUUID(), f.channelId, JSON.stringify(configuration()), f.accountId],
    ),
    { code: '42501' },
  );
  await assert.rejects(
    worker.query(
      "INSERT INTO monitoring_ai_settings_snapshots(run_id, channel_id, source) VALUES ($1, $2, 'DEFAULT')",
      [randomUUID(), f.channelId],
    ),
    { code: '42501' },
  );
});

test('migration backfills historical runs with no AI policy or fabricated model', async () => {
  const legacySchema = `ai_legacy_${randomUUID().replaceAll('-', '')}`;
  const connection = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  let created = false;
  await connection.connect();
  try {
    await connection.query(`CREATE SCHEMA ${legacySchema}`);
    created = true;
    await connection.query(`SET search_path TO ${legacySchema}`);
    const folder = path.resolve(__dirname, '../packages/persistence/migrations');
    const migrations = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of migrations.filter((name) => name < '024_ai_moderation_settings.sql')) {
      await connection.query(await readFile(path.join(folder, name), 'utf8'));
    }
    const f = await fixture(connection);
    const run = await start(f, connection);
    await connection.query(
      await readFile(path.join(folder, '024_ai_moderation_settings.sql'), 'utf8'),
    );
    const captured = await snapshot(run, connection);
    assert.equal(captured.source, 'LEGACY');
    assert.equal(captured.settings_id, null);
    assert.equal(captured.settings_revision, null);
    assert.equal(captured.configuration, null);
  } finally {
    try {
      if (created) await connection.query(`DROP SCHEMA ${legacySchema} CASCADE`);
    } finally {
      await connection.end();
    }
  }
});
