const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');

const { LeaseStore, LeaseLostError } = source('apps/worker/src/ingestion/lease-store.ts');
const { BatchWriter, StaleBatchError, MonitoringNotIngestingError, ChatAlreadyEndedError } = source(
  'apps/worker/src/ingestion/batch-writer.ts',
);
const { PollCycle } = source('apps/worker/src/ingestion/poll-cycle.ts');
const { YoutubeChatError } = source('packages/provider-adapters/src/youtube-chat.ts');
const { RetryStore } = source('apps/worker/src/ingestion/retry-store.ts');

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

async function batchFixture() {
  const f = await fixture();
  const lease = await store.claim(f.runId, randomUUID());
  assert.ok(lease);

  const writer = new BatchWriter(store);
  const checkpoint = await writer.checkpoint(lease);

  const broadcast = await admin.query(
    'SELECT live_chat_id FROM youtube_broadcasts WHERE session_id = $1',
    [f.sessionId],
  );

  const item = {
    id: 'message-1',
    snippet: {
      type: 'textMessageEvent',
      liveChatId: broadcast.rows[0].live_chat_id,
      publishedAt: '2026-01-01T00:00:00Z',
      textMessageDetails: { messageText: 'Test message' },
    },
  };

  return {
    ...f,
    lease,
    writer,
    item,
    batch: {
      expected_revision: checkpoint.revision,
      request_page_token: checkpoint.next_page_token,
      next_page_token: 'page-2',
      polling_interval_ms: 5000,
      items: [item],
    },
  };
}

test('batch persistence advances the checkpoint and marks the run RUNNING', async () => {
  const f = await batchFixture();

  assert.deepEqual(await f.writer.commit(f.lease, f.batch), {
    inserted: 1,
    revision: '1',
  });

  const result = await admin.query(
    `
      SELECT
        checkpoint.next_page_token,
        checkpoint.revision::text,
        checkpoint.next_poll_at - checkpoint.last_successful_poll_at
          = interval '5 seconds' AS respects_interval,
        run.status,
        run.started_at
      FROM youtube_chat_checkpoints checkpoint
      JOIN monitoring_runs run ON run.session_id = checkpoint.session_id
      WHERE run.id = $1
    `,
    [f.runId],
  );

  assert.equal(result.rows[0].next_page_token, 'page-2');
  assert.equal(result.rows[0].revision, '1');
  assert.equal(result.rows[0].respects_interval, true);
  assert.equal(result.rows[0].status, 'RUNNING');
  assert.ok(result.rows[0].started_at);
});

test('snapshot deduplication ignores JSON object key order', async () => {
  const f = await batchFixture();

  await f.writer.commit(f.lease, f.batch);

  const reordered = {
    snippet: {
      textMessageDetails: { messageText: 'Test message' },
      publishedAt: f.item.snippet.publishedAt,
      liveChatId: f.item.snippet.liveChatId,
      type: f.item.snippet.type,
    },
    id: f.item.id,
  };

  const result = await f.writer.commit(f.lease, {
    ...f.batch,
    expected_revision: '1',
    request_page_token: 'page-2',
    next_page_token: 'page-3',
    items: [reordered],
  });

  assert.deepEqual(result, { inserted: 0, revision: '2' });
});

test('only one response can advance a checkpoint revision', async () => {
  const f = await batchFixture();

  const results = await Promise.allSettled([
    f.writer.commit(f.lease, f.batch),
    f.writer.commit(f.lease, f.batch),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);

  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected.reason instanceof StaleBatchError);
});

test('a bad resource rolls back earlier observations and checkpoint changes', async () => {
  const f = await batchFixture();

  await assert.rejects(
    f.writer.commit(f.lease, {
      ...f.batch,
      items: [
        f.item,
        {
          ...f.item,
          id: 'message-2',
          snippet: {
            ...f.item.snippet,
            liveChatId: 'another-live-chat',
          },
        },
      ],
    }),
    /another live chat/,
  );

  const observations = await admin.query(
    'SELECT id FROM youtube_chat_observations WHERE session_id = $1',
    [f.sessionId],
  );
  assert.equal(observations.rows.length, 0);

  const checkpoint = await f.writer.checkpoint(f.lease);
  assert.equal(checkpoint.revision, '0');
  assert.equal(checkpoint.next_page_token, null);

  const run = await admin.query('SELECT status FROM monitoring_runs WHERE id = $1', [f.runId]);
  assert.equal(run.rows[0].status, 'STARTING');
});

test('a STOPPING run rejects new batches without advancing its checkpoint', async () => {
  const f = await batchFixture();

  await admin.query(
    `
      UPDATE monitoring_runs
      SET status = 'STOPPING', stop_requested_at = clock_timestamp()
      WHERE id = $1
    `,
    [f.runId],
  );

  await assert.rejects(f.writer.commit(f.lease, f.batch), MonitoringNotIngestingError);

  const result = await admin.query(
    'SELECT revision::text FROM youtube_chat_checkpoints WHERE session_id = $1',
    [f.sessionId],
  );
  assert.equal(result.rows[0].revision, '0');
});

test('an empty successful batch still advances its checkpoint', async () => {
  const f = await batchFixture();

  assert.deepEqual(await f.writer.commit(f.lease, { ...f.batch, items: [] }), {
    inserted: 0,
    revision: '1',
  });
});

test('a replaced worker cannot persist a batch', async () => {
  const f = await batchFixture();

  await expire(admin, f.runId);
  assert.ok(await store.claim(f.runId, randomUUID()));

  await assert.rejects(f.writer.commit(f.lease, f.batch), LeaseLostError);

  const result = await admin.query(
    'SELECT id FROM youtube_chat_observations WHERE session_id = $1',
    [f.sessionId],
  );
  assert.equal(result.rows.length, 0);
});

async function cycleFixture() {
  const f = await batchFixture();

  const result = await admin.query(
    'SELECT credential_account_id FROM monitoring_runs WHERE id = $1',
    [f.runId],
  );

  let tokenCalls = 0;
  let chatCalls = 0;

  const tokens = {
    async accessToken(accountId) {
      tokenCalls++;
      assert.equal(accountId, result.rows[0].credential_account_id);
      return 'test-cycle-access';
    },
  };

  const chat = {
    async list(input) {
      chatCalls++;
      assert.equal(input.accessToken, 'test-cycle-access');
      assert.equal(input.liveChatId, f.item.snippet.liveChatId);
      assert.equal(input.pageToken, null);

      return {
        next_page_token: 'page-2',
        polling_interval_ms: 60000,
        offline_at: null,
        items: [f.item],
      };
    },
  };

  return {
    ...f,
    tokens,
    chat,
    cycle: new PollCycle(store, f.writer, tokens, chat),
    get tokenCalls() {
      return tokenCalls;
    },
    get chatCalls() {
      return chatCalls;
    },
  };
}

test('poll cycle uses stored credentials and persists the provider batch', async () => {
  const f = await cycleFixture();

  assert.deepEqual(await f.cycle.run(f.lease), {
    kind: 'POLLED',
    inserted: 1,
    revision: '1',
    offline_at: null,
    chat_ended: false,
  });

  assert.equal(f.tokenCalls, 1);
  assert.equal(f.chatCalls, 1);
});

test('poll cycle waits without contacting providers before the next polling time', async () => {
  const f = await cycleFixture();

  await f.cycle.run(f.lease);
  const result = await f.cycle.run(f.lease);

  assert.equal(result.kind, 'WAIT');
  assert.equal(f.tokenCalls, 1);
  assert.equal(f.chatCalls, 1);
});

test('poll cycle skips providers when stop has been requested', async () => {
  const f = await cycleFixture();

  await admin.query(
    `
      UPDATE monitoring_runs
      SET status = 'STOPPING', stop_requested_at = clock_timestamp()
      WHERE id = $1
    `,
    [f.runId],
  );

  assert.deepEqual(await f.cycle.run(f.lease), {
    kind: 'STOP_REQUESTED',
  });

  assert.equal(f.tokenCalls, 0);
  assert.equal(f.chatCalls, 0);
});

test('provider failure leaves the polling checkpoint unchanged', async () => {
  const f = await cycleFixture();

  f.chat.list = async () => {
    throw new YoutubeChatError('YOUTUBE_RATE_LIMITED', 12000);
  };

  await assert.rejects(
    f.cycle.run(f.lease),
    (error) =>
      error instanceof YoutubeChatError &&
      error.code === 'YOUTUBE_RATE_LIMITED' &&
      error.retryAfterMs === 12000,
  );

  const checkpoint = await f.writer.checkpoint(f.lease);
  assert.equal(checkpoint.revision, '0');
  assert.equal(checkpoint.next_page_token, null);

  const observations = await admin.query(
    'SELECT id FROM youtube_chat_observations WHERE session_id = $1',
    [f.sessionId],
  );
  assert.equal(observations.rows.length, 0);
});

test('cancellation after receiving a response prevents batch persistence', async () => {
  const f = await cycleFixture();
  const controller = new AbortController();
  const original = f.chat.list;

  f.chat.list = async (input) => {
    const response = await original(input);
    controller.abort();
    return response;
  };

  await assert.rejects(
    f.cycle.run(f.lease, controller.signal),
    (error) => error instanceof YoutubeChatError && error.code === 'REQUEST_CANCELLED',
  );

  const checkpoint = await f.writer.checkpoint(f.lease);
  assert.equal(checkpoint.revision, '0');
});

test('a run cancelled during the external request cannot persist its response', async () => {
  const f = await cycleFixture();
  const original = f.chat.list;

  f.chat.list = async (input) => {
    const response = await original(input);

    await admin.query(
      `
        UPDATE monitoring_runs
        SET status = 'STOPPED', finished_at = clock_timestamp()
        WHERE id = $1
      `,
      [f.runId],
    );

    return response;
  };

  await assert.rejects(f.cycle.run(f.lease), LeaseLostError);

  const observations = await admin.query(
    'SELECT id FROM youtube_chat_observations WHERE session_id = $1',
    [f.sessionId],
  );
  assert.equal(observations.rows.length, 0);
});

test('the final chat event is persisted before reporting completion', async () => {
  const f = await cycleFixture();

  f.chat.list = async () => ({
    next_page_token: null,
    polling_interval_ms: 5000,
    offline_at: '2026-01-01T00:01:00Z',
    items: [
      {
        id: 'ended-event',
        snippet: {
          type: 'chatEndedEvent',
          liveChatId: f.item.snippet.liveChatId,
          publishedAt: '2026-01-01T00:01:00Z',
        },
      },
    ],
  });

  const result = await f.cycle.run(f.lease);

  assert.equal(result.kind, 'POLLED');
  assert.equal(result.chat_ended, true);
  assert.equal(result.offline_at, '2026-01-01T00:01:00Z');
  assert.equal(result.inserted, 1);

  const stored = await admin.query(
    'SELECT event_type FROM youtube_chat_observations WHERE session_id = $1',
    [f.sessionId],
  );
  assert.equal(stored.rows[0].event_type, 'chatEndedEvent');
});

test('finishing a run stores completion and releases its lease atomically', async () => {
  const f = await batchFixture();

  await f.writer.commit(f.lease, f.batch);
  assert.equal(await store.finish(f.lease, 'STOPPED'), 'STOPPED');

  const result = await admin.query(
    `
      SELECT run.status, run.finished_at, run.last_error_code, lease.owner_id
      FROM monitoring_runs run
      JOIN monitoring_worker_leases lease ON lease.run_id = run.id
      WHERE run.id = $1
    `,
    [f.runId],
  );

  assert.equal(result.rows[0].status, 'STOPPED');
  assert.ok(result.rows[0].finished_at);
  assert.equal(result.rows[0].last_error_code, null);
  assert.equal(result.rows[0].owner_id, null);

  await assert.rejects(store.finish(f.lease, 'STOPPED'), LeaseLostError);
});

test('a failed run stores only its safe error code', async () => {
  const f = await batchFixture();

  assert.equal(await store.finish(f.lease, 'FAILED', 'RECONNECT_REQUIRED'), 'FAILED');

  const result = await admin.query(
    'SELECT status, last_error_code FROM monitoring_runs WHERE id = $1',
    [f.runId],
  );

  assert.deepEqual(result.rows[0], {
    status: 'FAILED',
    last_error_code: 'RECONNECT_REQUIRED',
  });
});

test('a pending user stop takes precedence over provider failure', async () => {
  const f = await batchFixture();

  await admin.query(
    `
      UPDATE monitoring_runs
      SET
        status = 'STOPPING',
        stop_requested_at = clock_timestamp(),
        stopped_by_account_id = requested_by_account_id
      WHERE id = $1
    `,
    [f.runId],
  );

  assert.equal(await store.finish(f.lease, 'FAILED', 'YOUTUBE_FORBIDDEN'), 'STOPPED');

  const result = await admin.query(
    `
      SELECT
        last_error_code,
        stopped_by_account_id,
        finished_at >= stop_requested_at AS valid_completion
      FROM monitoring_runs
      WHERE id = $1
    `,
    [f.runId],
  );

  assert.equal(result.rows[0].last_error_code, null);
  assert.ok(result.rows[0].stopped_by_account_id);
  assert.equal(result.rows[0].valid_completion, true);
});

test('a previous owner cannot finish a run after takeover', async () => {
  const f = await batchFixture();

  await expire(admin, f.runId);
  const replacement = await store.claim(f.runId, randomUUID());
  assert.ok(replacement);

  await assert.rejects(store.finish(f.lease, 'FAILED', 'YOUTUBE_FORBIDDEN'), LeaseLostError);

  const result = await admin.query('SELECT status FROM monitoring_runs WHERE id = $1', [f.runId]);

  assert.equal(result.rows[0].status, 'STARTING');
  await store.heartbeat(replacement);
});

test('retry preserves the page token and respects Retry-After', async () => {
  const f = await batchFixture();
  const retries = new RetryStore(store);

  const result = await retries.schedule(f.lease, 'YOUTUBE_RATE_LIMITED', 12000);

  assert.equal(result.revision, '1');
  assert.equal(result.consecutive_failures, 1);

  const checkpoint = await admin.query(
    `
      SELECT
        next_page_token,
        last_error_code,
        next_poll_at - updated_at >= interval '12 seconds' AS respects_delay
      FROM youtube_chat_checkpoints
      WHERE session_id = $1
    `,
    [f.sessionId],
  );

  assert.equal(checkpoint.rows[0].next_page_token, null);
  assert.equal(checkpoint.rows[0].last_error_code, 'YOUTUBE_RATE_LIMITED');
  assert.equal(checkpoint.rows[0].respects_delay, true);

  await assert.rejects(f.writer.commit(f.lease, f.batch), StaleBatchError);
});

test('successful batch persistence clears retry state', async () => {
  const f = await batchFixture();
  const retries = new RetryStore(store);

  await retries.schedule(f.lease, 'YOUTUBE_UNAVAILABLE');

  await f.writer.commit(f.lease, {
    ...f.batch,
    expected_revision: '1',
  });

  const result = await admin.query(
    `
      SELECT
        checkpoint.consecutive_failures,
        checkpoint.last_error_code AS checkpoint_error,
        run.last_error_code AS run_error,
        run.status
      FROM monitoring_runs run
      JOIN youtube_chat_checkpoints checkpoint
        ON checkpoint.session_id = run.session_id
      WHERE run.id = $1
    `,
    [f.runId],
  );

  assert.deepEqual(result.rows[0], {
    consecutive_failures: 0,
    checkpoint_error: null,
    run_error: null,
    status: 'RUNNING',
  });
});

test('retry is rejected after a stop request', async () => {
  const f = await batchFixture();
  const retries = new RetryStore(store);

  await admin.query(
    `
      UPDATE monitoring_runs
      SET status = 'STOPPING', stop_requested_at = clock_timestamp()
      WHERE id = $1
    `,
    [f.runId],
  );

  await assert.rejects(
    retries.schedule(f.lease, 'YOUTUBE_UNAVAILABLE'),
    MonitoringNotIngestingError,
  );

  const result = await admin.query(
    'SELECT revision::text FROM youtube_chat_checkpoints WHERE session_id = $1',
    [f.sessionId],
  );

  assert.equal(result.rows[0].revision, '0');
});

test('a replacement worker detects persisted chat completion without provider calls', async () => {
  const f = await batchFixture();

  await f.writer.commit(f.lease, {
    ...f.batch,
    next_page_token: null,
    items: [
      {
        id: 'chat-ended',
        snippet: {
          type: 'chatEndedEvent',
          liveChatId: f.item.snippet.liveChatId,
          publishedAt: '2026-01-01T00:01:00Z',
        },
      },
    ],
  });

  // Simulate process death after commit but before run finalization.
  await expire(admin, f.runId);

  const replacementStore = new LeaseStore(pool);
  const replacementLease = await replacementStore.claim(f.runId, randomUUID());
  assert.ok(replacementLease);

  const cycle = new PollCycle(
    replacementStore,
    new BatchWriter(replacementStore),
    {
      async accessToken() {
        assert.fail('Completed chat must not request a token');
      },
    },
    {
      async list() {
        assert.fail('Completed chat must not call YouTube');
      },
    },
  );

  assert.deepEqual(await cycle.run(replacementLease), {
    kind: 'CHAT_ENDED',
  });

  assert.equal(await replacementStore.finish(replacementLease, 'STOPPED'), 'STOPPED');

  const observations = await admin.query(
    'SELECT id FROM youtube_chat_observations WHERE session_id = $1',
    [f.sessionId],
  );

  assert.equal(observations.rows.length, 1);
});

test('completed chat rejects further batch writes', async () => {
  const f = await batchFixture();

  await f.writer.commit(f.lease, {
    ...f.batch,
    next_page_token: null,
    offline_at: '2026-01-01T00:01:00Z',
    items: [],
  });

  await assert.rejects(
    f.writer.commit(f.lease, {
      ...f.batch,
      expected_revision: '1',
      request_page_token: null,
    }),
    ChatAlreadyEndedError,
  );

  const checkpoint = await f.writer.checkpoint(f.lease);
  assert.equal(checkpoint.revision, '1');
  assert.ok(checkpoint.chat_ended_at);
});

test('offline metadata with a continuation token does not end ingestion', async () => {
  const f = await batchFixture();

  await f.writer.commit(f.lease, {
    ...f.batch,
    offline_at: '2026-01-01T00:01:00Z',
    next_page_token: 'remaining-chat-page',
  });

  const checkpoint = await f.writer.checkpoint(f.lease);

  assert.equal(checkpoint.chat_ended_at, null);
  assert.equal(checkpoint.next_page_token, 'remaining-chat-page');
});

test('offline metadata without a continuation token persists completion', async () => {
  const f = await batchFixture();

  await f.writer.commit(f.lease, {
    ...f.batch,
    offline_at: '2026-01-01T00:01:00Z',
    next_page_token: null,
  });

  const checkpoint = await f.writer.checkpoint(f.lease);
  assert.ok(checkpoint.chat_ended_at);

  const observations = await admin.query(
    'SELECT id FROM youtube_chat_observations WHERE session_id = $1',
    [f.sessionId],
  );

  assert.equal(observations.rows.length, 1);
});
