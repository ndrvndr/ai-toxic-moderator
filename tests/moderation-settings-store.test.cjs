const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');

const { ModerationSettingsStore, ModerationSettingsConflict } = source(
  'apps/api/src/settings/moderation-settings-store.ts',
);
const schema = `settings_${randomUUID().replaceAll('-', '')}`;
const role = `settings_api_${randomUUID().replaceAll('-', '')}`;
let admin;
let pool;
let store;
let migrate;
let schemaCreated = false;
let roleCreated = false;

const configuration = {
  schema_version: 1,
  automatic_actions_enabled: false,
  rules: [],
};

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
  }
  ({ migrate } = await import('../scripts/database.mjs'));
  const { provisionRuntimeRole } = await import('../scripts/runtime-role.mjs');
  admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await admin.query(`SET search_path TO ${schema}`);
  await migrate(admin);
  await provisionRuntimeRole(admin, { role, password: randomUUID(), schema });
  roleCreated = true;
  pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${role}`,
    max: 4,
    statement_timeout: 5000,
  });
  store = new ModerationSettingsStore(pool);
});

after(async () => {
  try {
    if (pool) await pool.end();
  } finally {
    if (admin) {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        if (roleCreated) await admin.query(`DROP ROLE ${role}`);
      } finally {
        await admin.end();
      }
    }
  }
});

async function fixture() {
  const channelId = randomUUID();
  const accountId = randomUUID();
  await admin.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
    channelId,
    'Settings test channel',
  ]);
  await admin.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    accountId,
    'Settings test account',
  ]);
  return { channelId, accountId };
}

function save(f, expected_revision, value = configuration) {
  return store.save(f.channelId, f.accountId, { expected_revision, configuration: value });
}

async function insertRaw(f, revision, value = configuration) {
  return admin.query(
    `INSERT INTO channel_moderation_settings(id, channel_id, revision, configuration, created_by)
     VALUES($1, $2, $3, $4::jsonb, $5)`,
    [randomUUID(), f.channelId, revision, JSON.stringify(value), f.accountId],
  );
}

test('settings migration can be applied repeatedly', async () => {
  await migrate(admin);
  const result = await admin.query('SELECT name FROM schema_migrations WHERE name = $1', [
    '018_channel_moderation_settings.sql',
  ]);
  assert.equal(result.rows.length, 1);
});

test('API runtime permissions allow new revisions and preserve earlier configuration', async () => {
  const f = await fixture();
  assert.equal(await store.getLatest(f.channelId), null);
  const first = await save(f, 0);
  const changed = {
    ...configuration,
    rules: [{ rule_id: 'test.rule', rule_version: '1', minimum_severity: 2, action: 'DELETE' }],
  };
  const second = await save(f, 1, changed);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.notEqual(first.id, second.id);
  assert.equal(second.created_by, f.accountId);
  assert.deepEqual(await store.getLatest(f.channelId), second);
  const rows = await admin.query(
    'SELECT revision, configuration FROM channel_moderation_settings WHERE channel_id = $1 ORDER BY revision',
    [f.channelId],
  );
  assert.deepEqual(rows.rows, [
    { revision: 1, configuration },
    { revision: 2, configuration: changed },
  ]);
});

test('competing initial and subsequent writes produce one revision and one conflict', async () => {
  const f = await fixture();
  for (const expected of [0, 1]) {
    const results = await Promise.allSettled([save(f, expected), save(f, expected)]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(winners[0].value.revision, expected + 1);
    assert.ok(losers[0].reason instanceof ModerationSettingsConflict);
    assert.equal(losers[0].reason.currentRevision, expected + 1);
  }
  const result = await admin.query(
    'SELECT revision FROM channel_moderation_settings WHERE channel_id = $1 ORDER BY revision',
    [f.channelId],
  );
  assert.deepEqual(result.rows, [{ revision: 1 }, { revision: 2 }]);
});

test('uppercase UUIDs use the same scope and stale updates leave no extra records', async () => {
  const f = await fixture();
  await save(f, 0);
  await assert.rejects(
    save({ ...f, channelId: f.channelId.toUpperCase() }, 0),
    (error) => error instanceof ModerationSettingsConflict && error.currentRevision === 1,
  );
  assert.equal((await store.getLatest(f.channelId.toUpperCase())).revision, 1);
  const updated = await save(f, 1);
  assert.equal(updated.revision, 2);
});

test('channels have independent histories and do not read each other configuration', async () => {
  const first = await fixture();
  const second = await fixture();
  await save(first, 0);
  assert.equal(await store.getLatest(second.channelId), null);
  const saved = await save(second, 0);
  assert.equal(saved.revision, 1);
  assert.equal(saved.channel_id, second.channelId);
});

test('failed inserts roll back without consuming a revision or holding its lock', async () => {
  const f = await fixture();
  await save(f, 0);
  await assert.rejects(save({ ...f, accountId: randomUUID() }, 1), { code: '23503' });
  assert.equal((await store.getLatest(f.channelId)).revision, 1);
  assert.equal((await save(f, 1)).revision, 2);
  await assert.rejects(save({ ...f, channelId: randomUUID() }, 0), { code: '23503' });
});

test('invalid action configuration never reaches persisted history', async () => {
  const f = await fixture();
  await assert.rejects(
    save(f, 0, {
      ...configuration,
      rules: [{ rule_id: 'test.rule', rule_version: '1', minimum_severity: 2, action: 'TIMEOUT' }],
    }),
    (error) => error.name === 'ZodError',
  );
  assert.equal(await store.getLatest(f.channelId), null);
  assert.equal((await save(f, 0)).revision, 1);
});

test('database constraints enforce consecutive revisions and configuration structure', async () => {
  const f = await fixture();
  for (const revision of [0, 2]) {
    await assert.rejects(insertRaw(f, revision), { code: '23514' });
  }
  for (const value of [
    {},
    [],
    { ...configuration, schema_version: 2 },
    { ...configuration, automatic_actions_enabled: 'false' },
    { ...configuration, rules: {} },
    { ...configuration, rules: Array(101).fill({}) },
    { ...configuration, unexpected: true },
  ]) {
    await assert.rejects(insertRaw(f, 1, value), { code: '23514' });
  }
  await insertRaw(f, 1);
  await assert.rejects(insertRaw(f, 1), { code: '23514' });
  await insertRaw(f, 2);
});

test('history rejects updates and deletion even through the migration account', async () => {
  const first = await save(await fixture(), 0);
  await assert.rejects(
    admin.query('UPDATE channel_moderation_settings SET revision = 10 WHERE id = $1', [first.id]),
    { code: '23514' },
  );
  await assert.rejects(
    admin.query('DELETE FROM channel_moderation_settings WHERE id = $1', [first.id]),
    { code: '23514' },
  );
});

test('runtime role has no update, delete, or truncate permission on settings history', async () => {
  const first = await save(await fixture(), 0);
  for (const sql of [
    'UPDATE channel_moderation_settings SET revision = revision WHERE id = $1',
    'DELETE FROM channel_moderation_settings WHERE id = $1',
  ]) {
    await assert.rejects(pool.query(sql, [first.id]), { code: '42501' });
  }
  await assert.rejects(pool.query('TRUNCATE channel_moderation_settings'), { code: '42501' });
});
