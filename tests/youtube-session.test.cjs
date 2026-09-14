const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');

const { transaction } = source('packages/persistence/src/index.ts');
const { resolveYoutubeSession } = source('apps/api/src/monitoring/youtube-session.ts');

const schema = `youtube_session_${randomUUID().replaceAll('-', '')}`;

let admin;
let pool;
let schemaCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
  }

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('YouTube session tests require a local database.');
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

async function createAccount() {
  const accountId = randomUUID();

  await pool.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    accountId,
    'YouTube session test account',
  ]);

  return accountId;
}

function broadcast() {
  return Object.freeze({
    youtube_broadcast_id: `broadcast-${randomUUID()}`,
    youtube_channel_id: `channel-${randomUUID()}`,
    channel_title: 'Test channel',
    title: 'Test livestream',
    live_chat_id: `chat-${randomUUID()}`,
  });
}

function resolve(accountId, verifiedBroadcast) {
  return transaction(pool, (client) => resolveYoutubeSession(client, accountId, verifiedBroadcast));
}

test('a verified broadcast creates a YouTube session and owner membership', async () => {
  const accountId = await createAccount();
  const verified = broadcast();
  const result = await resolve(accountId, verified);

  const stored = await pool.query(
    `
      SELECT
        s.source,
        s.label,
        m.role,
        y.youtube_channel_id,
        b.youtube_broadcast_id,
        b.live_chat_id
      FROM stream_sessions s
      JOIN youtube_channels y ON y.channel_id = s.channel_id
      JOIN youtube_broadcasts b ON b.session_id = s.id
      JOIN channel_memberships m ON m.channel_id = s.channel_id
      WHERE s.id = $1 AND m.account_id = $2
    `,
    [result.session_id, accountId],
  );

  assert.deepEqual(stored.rows, [
    {
      source: 'YOUTUBE',
      label: verified.title,
      role: 'OWNER',
      youtube_channel_id: verified.youtube_channel_id,
      youtube_broadcast_id: verified.youtube_broadcast_id,
      live_chat_id: verified.live_chat_id,
    },
  ]);
});

test('concurrent requests reuse one channel and one history session', async () => {
  const accountId = await createAccount();
  const verified = broadcast();

  const results = await Promise.all(Array.from({ length: 4 }, () => resolve(accountId, verified)));

  for (const result of results) {
    assert.deepEqual(result, results[0]);
  }

  const sessions = await pool.query('SELECT id FROM stream_sessions WHERE channel_id = $1', [
    results[0].channel_id,
  ]);

  assert.equal(sessions.rows.length, 1);

  const channels = await pool.query(
    'SELECT channel_id FROM youtube_channels WHERE youtube_channel_id = $1',
    [verified.youtube_channel_id],
  );

  assert.equal(channels.rows.length, 1);
});

test('different broadcasts on one YouTube channel have separate history sessions', async () => {
  const accountId = await createAccount();
  const firstBroadcast = broadcast();
  const secondBroadcast = {
    ...broadcast(),
    youtube_channel_id: firstBroadcast.youtube_channel_id,
  };

  const first = await resolve(accountId, firstBroadcast);
  const second = await resolve(accountId, secondBroadcast);

  assert.equal(first.channel_id, second.channel_id);
  assert.notEqual(first.session_id, second.session_id);
});

test('conflicting channel or live chat cannot replace an existing mapping', async () => {
  const accountId = await createAccount();
  const verified = broadcast();
  const original = await resolve(accountId, verified);
  const differentChannel = `channel-${randomUUID()}`;

  for (const changed of [
    { ...verified, youtube_channel_id: differentChannel },
    { ...verified, live_chat_id: `chat-${randomUUID()}` },
  ]) {
    await assert.rejects(resolve(accountId, changed), (error) => {
      assert.equal(error.getStatus(), 409);
      assert.equal(error.getResponse().code, 'BROADCAST_MAPPING_CONFLICT');
      return true;
    });
  }

  assert.deepEqual(await resolve(accountId, verified), original);

  const rolledBackChannel = await pool.query(
    'SELECT channel_id FROM youtube_channels WHERE youtube_channel_id = $1',
    [differentChannel],
  );

  assert.equal(rolledBackChannel.rows.length, 0);
});

test('a missing account rolls back all newly created channel data', async () => {
  const verified = broadcast();

  await assert.rejects(resolve(randomUUID(), verified), (error) => error.code === '23503');

  const channel = await pool.query(
    'SELECT channel_id FROM youtube_channels WHERE youtube_channel_id = $1',
    [verified.youtube_channel_id],
  );

  const storedBroadcast = await pool.query(
    'SELECT session_id FROM youtube_broadcasts WHERE youtube_broadcast_id = $1',
    [verified.youtube_broadcast_id],
  );

  assert.equal(channel.rows.length, 0);
  assert.equal(storedBroadcast.rows.length, 0);
});
