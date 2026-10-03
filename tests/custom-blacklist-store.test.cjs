const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFile, readdir } = require('node:fs/promises');
const path = require('node:path');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');

const { CustomBlacklistStore, CustomBlacklistConflict } = source(
  'apps/api/src/settings/custom-blacklist-store.ts',
);
const { customBlacklistSnapshot } = source('packages/contracts/src/custom-blacklist.ts');
const schema = `blacklist_${randomUUID().replaceAll('-', '')}`;
const apiRole = `blacklist_api_${randomUUID().replaceAll('-', '')}`;
const workerRole = `blacklist_worker_${randomUUID().replaceAll('-', '')}`;
const disabled = { schema_version: 1, enabled: false, rules: [] };
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
  store = new CustomBlacklistStore(pool);
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

function configuration(pattern = 'abc', action = 'DELETE') {
  return {
    schema_version: 1,
    enabled: true,
    rules: [
      {
        id: randomUUID(),
        enabled: true,
        match_type: 'WORD',
        pattern,
        action,
        ...(action === 'DELETE_TIMEOUT' ? { duration_seconds: 300 } : {}),
      },
    ],
  };
}

async function fixture(connection = admin) {
  const f = { channelId: randomUUID(), accountId: randomUUID(), sessionId: randomUUID() };
  await connection.query('INSERT INTO accounts(id, display_name) VALUES ($1, $2)', [
    f.accountId,
    'Blacklist test owner',
  ]);
  await connection.query('INSERT INTO channels(id, display_name) VALUES ($1, $2)', [
    f.channelId,
    'Blacklist test channel',
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
    [f.sessionId, f.channelId, 'Blacklist test broadcast'],
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
  if (result.rows[0]?.role !== 'OWNER') throw new Error('Blacklist access revoked');
}

function save(f, expected_revision, value = disabled) {
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
    `SELECT run_id, channel_id, blacklist_id, blacklist_revision, configuration, source
     FROM monitoring_blacklist_snapshots WHERE run_id = $1`,
    [id],
  );
  assert.equal(result.rows.length, 1);
  return customBlacklistSnapshot.parse(result.rows[0]);
}

test('blacklist migration can be applied repeatedly', async () => {
  await migrate(admin);
  const result = await admin.query('SELECT name FROM schema_migrations WHERE name = $1', [
    '021_custom_blacklists.sql',
  ]);
  assert.equal(result.rows.length, 1);
});

test('runtime writes normalize patterns and retain immutable per-channel revisions', async () => {
  const f = await fixture();
  assert.equal(await store.getLatest(f.channelId), null);
  const input = configuration(' ＡＢＣ ', 'DELETE_TIMEOUT');
  const first = await save(f, 0, input);
  assert.equal(first.configuration.rules[0].pattern, 'abc');
  assert.equal(first.created_by, f.accountId);
  const second = await save(f, 1, configuration('cba', 'DELETE_BAN'));
  assert.equal(second.revision, 2);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(await store.getLatest(f.channelId.toUpperCase()), second);
  const history = await admin.query(
    'SELECT configuration FROM channel_custom_blacklists WHERE id = $1',
    [first.id],
  );
  assert.deepEqual(history.rows[0].configuration, first.configuration);
  const other = await fixture();
  assert.equal(await store.getLatest(other.channelId), null);
  assert.equal((await save(other, 0)).revision, 1);
});

test('competing writes produce one revision and a conflict without consuming another revision', async () => {
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
    assert.ok(losers[0].reason instanceof CustomBlacklistConflict);
    assert.equal(losers[0].reason.currentRevision, expected + 1);
  }
  assert.equal((await store.getLatest(f.channelId)).revision, 2);
});

test('invalid configurations and authorization failures never create revisions', async () => {
  const f = await fixture();
  const invalid = configuration('abc', 'DELETE_TIMEOUT');
  delete invalid.rules[0].duration_seconds;
  await assert.rejects(save(f, 0, invalid), (error) => error.name === 'ZodError');
  await assert.rejects(
    store.save(
      f.channelId,
      f.accountId,
      {
        expected_revision: 0,
        configuration: disabled,
      },
      async () => {
        throw new Error('Blacklist access revoked');
      },
    ),
    /Blacklist access revoked/,
  );
  assert.equal(await store.getLatest(f.channelId), null);
  await assert.rejects(
    store.save(
      f.channelId,
      randomUUID(),
      {
        expected_revision: 0,
        configuration: disabled,
      },
      async () => {},
    ),
    { code: '23503' },
  );
  assert.equal((await save(f, 0)).revision, 1);
});

test('ownership is rechecked after a save waits for the channel revision lock', async () => {
  const f = await fixture();
  const blocker = await pool.connect();
  let waiting;
  let locked = false;
  try {
    await blocker.query('BEGIN');
    locked = true;
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `custom-blacklist:${f.channelId}`,
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
    const outcome = await waiting;
    assert.equal(outcome.saved, false);
    assert.equal(outcome.error.message, 'Blacklist access revoked');
    assert.equal(await store.getLatest(f.channelId), null);
  } finally {
    if (locked) await blocker.query('ROLLBACK');
    blocker.release();
    if (waiting) await waiting;
  }
});

test('new runs capture committed blacklist revisions while previous snapshots stay unchanged', async () => {
  const f = await fixture();
  const first = await start(f);
  const original = await snapshot(first);
  assert.deepEqual(original, {
    run_id: first,
    channel_id: f.channelId,
    blacklist_id: null,
    blacklist_revision: null,
    configuration: disabled,
    source: 'DEFAULT',
  });
  const one = await save(f, 0, configuration('abc', 'DELETE_TIMEOUT'));
  assert.deepEqual(await snapshot(first), original);
  await finish(first);
  const second = await start(f);
  const selected = await snapshot(second);
  assert.equal(selected.blacklist_id, one.id);
  assert.equal(selected.blacklist_revision, 1);
  assert.equal(selected.source, 'SAVED');
  assert.deepEqual(selected.configuration, one.configuration);
  const two = await save(f, 1, disabled);
  assert.deepEqual(await snapshot(second), selected);
  await finish(second);
  const third = await start(f);
  assert.equal((await snapshot(third)).blacklist_id, two.id);
  assert.deepEqual((await snapshot(third)).configuration, disabled);
  assert.deepEqual(await snapshot(second), selected);
  const other = await fixture();
  assert.equal((await snapshot(await start(other))).source, 'DEFAULT');
});

test('run capture ignores an uncommitted newer blacklist revision', async () => {
  const f = await fixture();
  const first = await save(f, 0, configuration('abc'));
  const writer = await pool.connect();
  let writing = false;
  try {
    await writer.query('BEGIN');
    writing = true;
    await writer.query(
      `INSERT INTO channel_custom_blacklists(id, channel_id, revision, configuration, created_by)
       VALUES ($1, $2, 2, $3::jsonb, $4)`,
      [randomUUID(), f.channelId, JSON.stringify(disabled), f.accountId],
    );
    const run = await start(f);
    assert.equal((await snapshot(run)).blacklist_id, first.id);
    await writer.query('COMMIT');
    writing = false;
    assert.equal((await snapshot(run)).blacklist_revision, 1);
    await finish(run);
    assert.equal((await snapshot(await start(f))).blacklist_revision, 2);
  } finally {
    if (writing) await writer.query('ROLLBACK');
    writer.release();
  }
});

test('rolling back run creation also removes its blacklist and existing settings snapshots', async () => {
  const f = await fixture();
  await save(f, 0, configuration());
  const client = await pool.connect();
  let run;
  try {
    await client.query('BEGIN');
    run = await start(f, client);
    assert.equal((await snapshot(run, client)).source, 'SAVED');
    assert.equal(
      (
        await client.query('SELECT run_id FROM monitoring_settings_snapshots WHERE run_id = $1', [
          run,
        ])
      ).rowCount,
      1,
    );
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
  assert.equal(
    (await pool.query('SELECT run_id FROM monitoring_blacklist_snapshots WHERE run_id = $1', [run]))
      .rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT run_id FROM monitoring_settings_snapshots WHERE run_id = $1', [run]))
      .rowCount,
    0,
  );
});

test('snapshots reject foreign channels, revision mismatches, fabricated configuration, and legacy writes', async () => {
  const f = await fixture();
  const blacklist = await save(f, 0, configuration());
  const run = await start(f);
  const other = await fixture();
  for (const [channel, revision, config] of [
    [other.channelId, 1, blacklist.configuration],
    [f.channelId, 2, blacklist.configuration],
    [f.channelId, 1, disabled],
  ]) {
    await assert.rejects(
      admin.query(
        `INSERT INTO monitoring_blacklist_snapshots(
        run_id, channel_id, blacklist_id, blacklist_revision, configuration, source
       ) VALUES ($1, $2, $3, $4, $5::jsonb, 'SAVED')`,
        [randomUUID(), channel, blacklist.id, revision, JSON.stringify(config)],
      ),
      { code: '23514' },
    );
  }
  await assert.rejects(
    admin.query(
      `INSERT INTO monitoring_blacklist_snapshots(run_id, channel_id, configuration, source)
     VALUES ($1, $2, $3::jsonb, 'LEGACY')`,
      [randomUUID(), f.channelId, JSON.stringify(disabled)],
    ),
    { code: '23514' },
  );
  await assert.rejects(
    admin.query(
      `INSERT INTO monitoring_blacklist_snapshots(run_id, channel_id, configuration, source)
     VALUES ($1, $2, $3::jsonb, 'DEFAULT')`,
      [randomUUID(), f.channelId, JSON.stringify(disabled)],
    ),
    { code: '23503' },
  );
  await assert.rejects(
    admin.query(
      `INSERT INTO monitoring_blacklist_snapshots(run_id, channel_id, configuration, source)
     VALUES ($1, $2, $3::jsonb, 'DEFAULT')`,
      [run, f.channelId, JSON.stringify(disabled)],
    ),
    { code: '23505' },
  );
  await assert.rejects(
    admin.query(
      `INSERT INTO monitoring_blacklist_snapshots(run_id, channel_id, configuration, source)
     VALUES ($1, $2, $3::jsonb, 'DEFAULT')`,
      [run, other.channelId, JSON.stringify(disabled)],
    ),
    { code: '23505' },
  );
});

test('blacklist revision structure is enforced and histories cannot be updated or deleted', async () => {
  const f = await fixture();
  const insert = (revision, config) =>
    admin.query(
      `INSERT INTO channel_custom_blacklists(id, channel_id, revision, configuration, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [randomUUID(), f.channelId, revision, JSON.stringify(config), f.accountId],
    );
  for (const revision of [0, 2])
    await assert.rejects(insert(revision, disabled), { code: '23514' });
  for (const config of [
    {},
    [],
    { ...disabled, schema_version: 2 },
    { ...disabled, enabled: 'false' },
    { ...disabled, rules: {} },
    { ...disabled, rules: Array(101).fill({}) },
    { ...disabled, unexpected: true },
  ])
    await assert.rejects(insert(1, config), { code: '23514' });
  const saved = await save(f, 0);
  const run = await start(f);
  for (const [table, key, id] of [
    ['channel_custom_blacklists', 'id', saved.id],
    ['monitoring_blacklist_snapshots', 'run_id', run],
  ]) {
    for (const sql of [
      `UPDATE ${table} SET configuration = configuration WHERE ${key} = $1`,
      `DELETE FROM ${table} WHERE ${key} = $1`,
    ]) {
      await assert.rejects(admin.query(sql, [id]), { code: '23514' });
      await assert.rejects(pool.query(sql, [id]), { code: '42501' });
    }
    await assert.rejects(pool.query(`TRUNCATE ${table}`), { code: '42501' });
  }
});

test('worker role can read captured policy but cannot write or select current channel revisions', async () => {
  const f = await fixture();
  const saved = await save(f, 0, configuration());
  const run = await start(f);
  assert.deepEqual((await snapshot(run, worker)).configuration, saved.configuration);
  await assert.rejects(worker.query('SELECT id FROM channel_custom_blacklists LIMIT 0'), {
    code: '42501',
  });
  await assert.rejects(
    worker.query(
      `INSERT INTO channel_custom_blacklists(id, channel_id, revision, configuration, created_by)
     VALUES ($1, $2, 2, $3::jsonb, $4)`,
      [randomUUID(), f.channelId, JSON.stringify(disabled), f.accountId],
    ),
    { code: '42501' },
  );
  await assert.rejects(
    worker.query(
      `INSERT INTO monitoring_blacklist_snapshots(run_id, channel_id, configuration, source)
     VALUES ($1, $2, $3::jsonb, 'DEFAULT')`,
      [randomUUID(), f.channelId, JSON.stringify(disabled)],
    ),
    { code: '42501' },
  );
  await assert.rejects(
    worker.query('DELETE FROM monitoring_blacklist_snapshots WHERE run_id = $1', [run]),
    { code: '42501' },
  );
});

test('migration backfills prior runs with disabled legacy policy instead of assigning a new blacklist', async () => {
  const legacySchema = `blacklist_legacy_${randomUUID().replaceAll('-', '')}`;
  const connection = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  let created = false;
  await connection.connect();
  try {
    await connection.query(`CREATE SCHEMA ${legacySchema}`);
    created = true;
    await connection.query(`SET search_path TO ${legacySchema}`);
    const folder = path.resolve(__dirname, '../packages/persistence/migrations');
    const migrations = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of migrations.filter((name) => name < '021_custom_blacklists.sql')) {
      await connection.query(await readFile(path.join(folder, name), 'utf8'));
    }
    const f = await fixture(connection);
    const run = await start(f, connection);
    await connection.query(await readFile(path.join(folder, '021_custom_blacklists.sql'), 'utf8'));
    const captured = await snapshot(run, connection);
    assert.equal(captured.source, 'LEGACY');
    assert.equal(captured.blacklist_id, null);
    assert.deepEqual(captured.configuration, disabled);
  } finally {
    try {
      if (created) await connection.query(`DROP SCHEMA ${legacySchema} CASCADE`);
    } finally {
      await connection.end();
    }
  }
});
