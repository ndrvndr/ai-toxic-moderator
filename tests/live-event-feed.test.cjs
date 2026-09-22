require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client, Pool } = require('pg');

const { source } = require('./helpers/source.cjs');
const { LiveAccessService, LiveAccessError } = source('apps/api/src/live/live-access.service.ts');
const { SessionService, tokenHash } = source('apps/api/src/auth/session.service.ts');
const {
  appendLiveEvent,
  readLiveEvents,
  InvalidLiveEventCursorError,
  LiveEventSessionNotFoundError,
  transaction,
} = source('packages/persistence/src/index.ts');

const schema = `live_event_${randomUUID().replaceAll('-', '')}`;

let pool;
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
    if (client) {
      try {
        if (schemaCreated) await client.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await client.end();
      }
    }
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

function eventInput(f, type = 'chat.updated') {
  return {
    channelId: f.channelId,
    sessionId: f.sessionId,
    runId: f.runId,
    type,
  };
}

function append(f, type) {
  return transaction(pool, (connection) => appendLiveEvent(connection, eventInput(f, type)));
}

test('live event migration can be applied repeatedly', async () => {
  await migrate(client);

  const result = await client.query('SELECT name FROM schema_migrations WHERE name = $1', [
    '009_live_event_feed.sql',
  ]);

  assert.equal(result.rows.length, 1);
});

test('concurrent events receive unique ordered sequences within a session', async () => {
  const f = await fixture();

  const results = await Promise.all(Array.from({ length: 4 }, () => append(f)));

  assert.deepEqual(
    results.map((result) => Number(result.sequence)).sort((a, b) => a - b),
    [1, 2, 3, 4],
  );

  const stored = await client.query(
    `
      SELECT sequence::text
      FROM live_events
      WHERE channel_id = $1 AND session_id = $2
      ORDER BY sequence
    `,
    [f.channelId, f.sessionId],
  );

  assert.deepEqual(
    stored.rows.map((row) => row.sequence),
    ['1', '2', '3', '4'],
  );
});

test('rollback removes the event and rolls back its sequence allocation', async () => {
  const f = await fixture();

  await assert.rejects(
    transaction(pool, async (connection) => {
      await appendLiveEvent(connection, eventInput(f));
      throw new Error('Simulated transaction failure');
    }),
    /Simulated transaction failure/,
  );

  const stored = await client.query('SELECT sequence FROM live_events WHERE session_id = $1', [
    f.sessionId,
  ]);
  assert.equal(stored.rows.length, 0);

  assert.deepEqual(await append(f), { sequence: '1' });
});

test('each session has an independent sequence', async () => {
  const first = await fixture();
  const second = await fixture();

  assert.deepEqual(await append(first), { sequence: '1' });
  assert.deepEqual(await append(first, 'monitoring.updated'), { sequence: '2' });
  assert.deepEqual(await append(second), { sequence: '1' });
});

test('events cannot reference a monitoring run from another session', async () => {
  const first = await fixture();
  const second = await fixture();

  await assert.rejects(
    transaction(pool, (connection) =>
      appendLiveEvent(connection, {
        ...eventInput(first),
        runId: second.runId,
      }),
    ),
    (error) => error.code === '23503',
  );

  assert.deepEqual(await append(first), { sequence: '1' });
});

test('stored events cannot be updated', async () => {
  const f = await fixture();
  await append(f);

  await assert.rejects(
    client.query(
      `
        UPDATE live_events
        SET event_type = 'monitoring.updated'
        WHERE session_id = $1
      `,
      [f.sessionId],
    ),
    (error) => error.code === '23514',
  );
});

function read(f, after = null, limit = 100) {
  return transaction(pool, (connection) =>
    readLiveEvents(connection, {
      channelId: f.channelId,
      sessionId: f.sessionId,
      after,
      limit,
    }),
  );
}

test('a session without events starts at cursor zero', async () => {
  const f = await fixture();

  assert.deepEqual(await read(f), {
    watermark: '0',
    next_cursor: '0',
    has_more: false,
    items: [],
  });
});

test('a new subscription starts at the current watermark', async () => {
  const f = await fixture();

  await append(f);
  await append(f, 'monitoring.updated');

  assert.deepEqual(await read(f), {
    watermark: '2',
    next_cursor: '2',
    has_more: false,
    items: [],
  });

  await append(f);

  const page = await read(f, '2');

  assert.deepEqual(page.items, [
    {
      sequence: '3',
      run_id: f.runId,
      event_type: 'chat.updated',
    },
  ]);
  assert.equal(page.next_cursor, '3');
});

test('replay uses ascending pages without skipping pending events', async () => {
  const f = await fixture();

  await append(f);
  await append(f, 'monitoring.updated');
  await append(f);

  const first = await read(f, '0', 2);

  assert.deepEqual(
    first.items.map((event) => event.sequence),
    ['1', '2'],
  );
  assert.equal(first.watermark, '3');
  assert.equal(first.next_cursor, '2');
  assert.equal(first.has_more, true);

  const second = await read(f, first.next_cursor, 2);

  assert.deepEqual(
    second.items.map((event) => event.sequence),
    ['3'],
  );
  assert.equal(second.next_cursor, '3');
  assert.equal(second.has_more, false);

  const empty = await read(f, second.next_cursor, 2);

  assert.equal(empty.items.length, 0);
  assert.equal(empty.next_cursor, '3');
  assert.equal(empty.has_more, false);
});

test('replay remains scoped to its channel and session', async () => {
  const first = await fixture();
  const second = await fixture();

  await append(first);
  await append(second, 'monitoring.updated');

  const page = await read(first, '0');

  assert.deepEqual(page.items, [
    {
      sequence: '1',
      run_id: first.runId,
      event_type: 'chat.updated',
    },
  ]);

  await assert.rejects(
    read({
      ...first,
      sessionId: second.sessionId,
    }),
    LiveEventSessionNotFoundError,
  );
});

test('malformed and future cursors are rejected', async () => {
  const f = await fixture();

  for (const cursor of [
    '',
    '-1',
    '01',
    '1.5',
    '1e2',
    ' 1',
    '9223372036854775808',
    '9'.repeat(100),
  ]) {
    await assert.rejects(read(f, cursor), InvalidLiveEventCursorError);
  }

  await assert.rejects(read(f, '1'), InvalidLiveEventCursorError);
});

test('invalid page limits are rejected', async () => {
  const f = await fixture();

  for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
    await assert.rejects(read(f, '0', limit), RangeError);
  }
});

test('replay does not expose uncommitted events', async () => {
  const f = await fixture();
  const connection = await pool.connect();

  try {
    await connection.query('BEGIN');
    await appendLiveEvent(connection, eventInput(f));

    const beforeCommit = await read(f, '0');

    assert.equal(beforeCommit.watermark, '0');
    assert.deepEqual(beforeCommit.items, []);

    await connection.query('COMMIT');

    const afterCommit = await read(f, '0');

    assert.equal(afterCommit.watermark, '1');
    assert.deepEqual(
      afterCommit.items.map((event) => event.sequence),
      ['1'],
    );
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
  }
});

async function authenticatedFixture(role = 'OWNER') {
  const f = await fixture();
  const token = randomBytes(32).toString('base64url');

  if (role !== null) {
    await client.query(
      `
        INSERT INTO channel_memberships(channel_id, account_id, role)
        VALUES($1, $2, $3)
      `,
      [f.channelId, f.accountId, role],
    );
  }

  await client.query(
    `
      INSERT INTO dashboard_sessions(
        id, account_id, token_hash, expires_at, auth_provider
      )
      VALUES(
        $1, $2, $3,
        clock_timestamp() + interval '1 hour',
        'development'
      )
    `,
    [randomUUID(), f.accountId, tokenHash(token)],
  );

  const database = { pool };
  const sessions = new SessionService(database, {
    DEV_AUTH_ENABLED: true,
    GOOGLE_AUTH_ENABLED: false,
  });

  const access = new LiveAccessService(database, sessions);

  return {
    ...f,
    token,
    sessions,
    access,
    subscription: {
      channelId: f.channelId,
      sessionId: f.sessionId,
      after: '0',
    },
  };
}

function accessError(status, closeCode) {
  return (error) =>
    error instanceof LiveAccessError && error.status === status && error.closeCode === closeCode;
}

test('owners and moderators can read their live events', async () => {
  for (const role of ['OWNER', 'MODERATOR']) {
    const f = await authenticatedFixture(role);
    await append(f);

    const page = await f.access.read(f.token, f.subscription);

    assert.deepEqual(page.items, [
      {
        sequence: '1',
        run_id: f.runId,
        event_type: 'chat.updated',
      },
    ]);
  }
});

test('operators and accounts without membership cannot read live events', async () => {
  for (const role of ['OPERATOR', null]) {
    const f = await authenticatedFixture(role);
    await append(f);

    await assert.rejects(f.access.read(f.token, f.subscription), accessError(403, 4003));
  }
});

test('a valid account cannot read another channel through its identifiers', async () => {
  const first = await authenticatedFixture();
  const second = await authenticatedFixture();

  await append(second);

  await assert.rejects(first.access.read(first.token, second.subscription), accessError(403, 4003));
});

test('a session cannot be substituted into an authorized channel', async () => {
  const first = await authenticatedFixture();
  const second = await authenticatedFixture();

  await assert.rejects(
    first.access.read(first.token, {
      ...first.subscription,
      sessionId: second.sessionId,
    }),
    accessError(404, 4004),
  );
});

test('missing and unknown sessions cannot read live events', async () => {
  const f = await authenticatedFixture();

  for (const token of [null, randomBytes(32).toString('base64url')]) {
    await assert.rejects(f.access.read(token, f.subscription), accessError(401, 4001));
  }
});

test('expired sessions cannot read live events', async () => {
  const f = await authenticatedFixture();

  await client.query(
    `
      UPDATE dashboard_sessions
      SET
        created_at = statement_timestamp() - interval '2 hours',
        expires_at = statement_timestamp() - interval '1 hour'
      WHERE token_hash = $1
    `,
    [tokenHash(f.token)],
  );

  await assert.rejects(f.access.read(f.token, f.subscription), accessError(401, 4001));
});

test('revoked sessions are rejected on the next feed read', async () => {
  const f = await authenticatedFixture();

  await f.access.read(f.token, f.subscription);
  await f.sessions.revoke(tokenHash(f.token));

  await assert.rejects(f.access.read(f.token, f.subscription), accessError(401, 4001));
});

test('membership changes are enforced on subsequent feed reads', async () => {
  const f = await authenticatedFixture();

  await f.access.read(f.token, f.subscription);

  await client.query(
    `
      UPDATE channel_memberships
      SET role = 'OPERATOR'
      WHERE channel_id = $1 AND account_id = $2
    `,
    [f.channelId, f.accountId],
  );

  await assert.rejects(f.access.read(f.token, f.subscription), accessError(403, 4003));

  await client.query(
    `
      DELETE FROM channel_memberships
      WHERE channel_id = $1 AND account_id = $2
    `,
    [f.channelId, f.accountId],
  );

  await assert.rejects(f.access.read(f.token, f.subscription), accessError(403, 4003));
});

test('disabled authentication providers invalidate existing sessions', async () => {
  const f = await authenticatedFixture();

  const database = { pool };
  const sessions = new SessionService(database, {
    DEV_AUTH_ENABLED: false,
    GOOGLE_AUTH_ENABLED: false,
  });

  const access = new LiveAccessService(database, sessions);

  await assert.rejects(access.read(f.token, f.subscription), accessError(401, 4001));
});

test('future cursors return a safe access error', async () => {
  const f = await authenticatedFixture();

  await assert.rejects(
    f.access.read(f.token, {
      ...f.subscription,
      after: '1',
    }),
    accessError(400, 4000),
  );
});
