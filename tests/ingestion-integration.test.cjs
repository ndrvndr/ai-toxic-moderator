const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');

const { createApi } = require('../apps/api/dist/app');
const { GoogleService } = require('../apps/api/dist/auth/google.service');
const { loadConfig } = require('@moderator/config');
const {
  startMonitoringResponse,
  stopMonitoringResponse,
  monitoringStatusResponse,
} = require('@moderator/contracts');
const {
  GoogleProvider,
  GoogleTokenStore,
  YoutubeChatAdapter,
  encryptToken,
  YOUTUBE_SCOPE,
} = require('@moderator/provider-adapters');
const { LeaseStore, LeaseLostError } = require('../apps/worker/dist/ingestion/lease-store');
const { BatchWriter } = require('../apps/worker/dist/ingestion/batch-writer');
const { PollCycle } = require('../apps/worker/dist/ingestion/poll-cycle');
const { RetryStore } = require('../apps/worker/dist/ingestion/retry-store');
const { IngestionCoordinator } = require('../apps/worker/dist/ingestion/coordinator');
const {
  createClassificationStore,
} = require('../apps/worker/dist/ingestion/create-classification-store');
const { ActionPlanStore } = require('../apps/worker/dist/ingestion/action-plan-store');

const schema = `ingestion_integration_${randomUUID().replaceAll('-', '')}`;
const runtimeRole = `atm_http_${randomUUID().replaceAll('-', '')}`;
const accountId = randomUUID();
const origin = 'http://127.0.0.1:3000';
const broadcasts = new Map();
const workerRole = `atm_ingestion_${randomUUID().replaceAll('-', '')}`;
const encryptionKey = 'ab'.repeat(32);

let admin;
let pool;
let app;
let base;
let cookie;
let schemaCreated = false;
let roleCreated = false;
let workerPool;
let workerRoleCreated = false;
let refreshCalls = 0;
let chatCalls = 0;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) throw new Error('Set TEST_DATABASE_URL to a local test database.');

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Monitoring HTTP tests require a local database.');
  }

  const { migrate } = await import('../scripts/database.mjs');
  const { provisionRuntimeRole } = await import('../scripts/runtime-role.mjs');

  admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await admin.query(`SET search_path TO ${schema}`);
  await migrate(admin);

  await admin.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    accountId,
    'Monitoring HTTP test account',
  ]);

  await provisionRuntimeRole(admin, {
    role: runtimeRole,
    password: randomUUID(),
    schema,
  });
  roleCreated = true;

  const { provisionWorkerRole } = await import('../scripts/worker-role.mjs');

  await provisionWorkerRole(admin, {
    role: workerRole,
    password: randomUUID(),
    schema,
  });
  workerRoleCreated = true;

  workerPool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${workerRole}`,
    max: 4,
  });

  await admin.query(
    `
    INSERT INTO google_credentials(
      account_id,
      access_token_ciphertext,
      refresh_token_ciphertext,
      expires_at,
      scopes
    )
    VALUES($1, $2, $3, clock_timestamp() - interval '1 minute', $4)
  `,
    [
      accountId,
      encryptToken('expired-test-access', encryptionKey, `${accountId}:access`),
      encryptToken('test-refresh-token', encryptionKey, `${accountId}:refresh`),
      `openid profile ${YOUTUBE_SCOPE}`,
    ],
  );

  pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${runtimeRole}`,
    max: 4,
  });

  const config = loadConfig({
    DATABASE_URL: url,
    NODE_ENV: 'test',
    DEV_AUTH_ENABLED: 'true',
    DEV_ACCOUNT_ID: accountId,
    DASHBOARD_ORIGIN: origin,
  });

  app = await createApi(config, pool);

  // Mock only the external Google boundary; use real HTTP, guards and database.
  app.get(GoogleService).verifyBroadcast = async (actorId, broadcastId) => {
    assert.equal(actorId, accountId);
    const verified = broadcasts.get(broadcastId);
    assert.ok(verified, 'The broadcast must be registered by the test');
    return verified;
  };

  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  const login = await fetch(`${base}/v1/auth/dev-session`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  });

  assert.equal(login.status, 201, await login.clone().text());
  cookie = login.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  try {
    if (workerPool) await workerPool.end();
  } finally {
    try {
      if (app) await app.close();
      else if (pool) await pool.end();
    } finally {
      if (admin) {
        try {
          if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          if (roleCreated) await admin.query(`DROP ROLE ${runtimeRole}`);
          if (workerRoleCreated) await admin.query(`DROP ROLE ${workerRole}`);
        } finally {
          await admin.end();
        }
      }
    }
  }
});

function request(path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function registerBroadcast() {
  const verified = {
    youtube_broadcast_id: `broadcast-${randomUUID()}`,
    youtube_channel_id: `channel-${randomUUID()}`,
    channel_title: 'Test channel',
    title: 'Test livestream',
    live_chat_id: `chat-${randomUUID()}`,
  };

  broadcasts.set(verified.youtube_broadcast_id, verified);
  return verified;
}

async function startRun() {
  const broadcast = registerBroadcast();
  const response = await request('/v1/monitoring/start', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: { youtube_broadcast_id: broadcast.youtube_broadcast_id },
  });

  assert.equal(response.status, 200, await response.clone().text());
  return startMonitoringResponse.parse(await response.json()).run;
}

function runPath(run) {
  return `/v1/channels/${run.channel_id}/monitoring/${run.id}`;
}

function createWorker(actionPlans) {
  const leases = new LeaseStore(workerPool);
  const classifications = createClassificationStore(actionPlans);
  const writer = new BatchWriter(leases, classifications);

  const provider = new GoogleProvider(async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init.body.get('grant_type'), 'refresh_token');
    assert.equal(init.body.get('refresh_token'), 'test-refresh-token');
    refreshCalls++;

    return Response.json({
      access_token: 'fresh-test-access',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: `openid profile ${YOUTUBE_SCOPE}`,
    });
  });

  const tokens = new GoogleTokenStore(
    workerPool,
    {
      GOOGLE_CLIENT_ID: 'integration-test.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-only-secret',
      TOKEN_ENCRYPTION_KEY: encryptionKey,
    },
    provider,
  );

  const chat = new YoutubeChatAdapter(async (url, init) => {
    const params = new URL(url).searchParams;
    const liveChatId = params.get('liveChatId');

    assert.equal(init.headers.Authorization, 'Bearer fresh-test-access');
    assert.ok(liveChatId);
    chatCalls++;

    // Return the same message on successive pages to exercise deduplication.
    return Response.json({
      nextPageToken: params.has('pageToken') ? 'page-3' : 'page-2',
      pollingIntervalMillis: 60000,
      items: [
        {
          id: 'integration-message',
          snippet: {
            type: 'textMessageEvent',
            liveChatId,
            publishedAt: '2026-01-01T00:00:00Z',
            textMessageDetails: { messageText: 'Integration test message' },
          },
          authorDetails: {
            channelId: 'test-author',
            displayName: 'Test viewer',
          },
        },
      ],
    });
  });

  const cycle = new PollCycle(leases, writer, tokens, chat);

  return {
    leases,
    writer,
    coordinator: new IngestionCoordinator(workerPool, leases, cycle, new RetryStore(leases)),
  };
}

async function statusOf(run) {
  const response = await request(runPath(run));
  assert.equal(response.status, 200, await response.clone().text());
  return monitoringStatusResponse.parse(await response.json()).run;
}

async function stopThroughApi(run) {
  const response = await request(`${runPath(run)}/stop`, {
    method: 'POST',
    body: {},
  });

  assert.equal(response.status, 200, await response.clone().text());
  return stopMonitoringResponse.parse(await response.json()).run;
}

async function makeDue(run) {
  await admin.query(
    `
      UPDATE youtube_chat_checkpoints
      SET next_poll_at = clock_timestamp() - interval '1 second'
      WHERE session_id = $1
    `,
    [run.session_id],
  );
}

async function readPlans(run) {
  const result = await admin.query(
    `SELECT id, classification_id, action, policy_version
     FROM youtube_moderation_action_plans
     WHERE channel_id = $1 AND session_id = $2 ORDER BY id`,
    [run.channel_id, run.session_id],
  );
  return result.rows;
}

test('HTTP start, scheduled ingestion and HTTP stop complete across runtime roles', async () => {
  const worker = createWorker();

  assert.equal((await worker.coordinator.tick()).kind, 'IDLE');

  const run = await startRun();
  assert.equal(run.status, 'STARTING');

  const first = await worker.coordinator.tick();
  assert.equal(first.kind, 'POLLED');
  assert.equal(first.inserted, 1);
  const classificationsStored = await admin.query(
    `
    SELECT
      outcome,
      primary_category,
      severity,
      classifier_version,
      policy_version
    FROM youtube_chat_classifications
    WHERE session_id = $1
  `,
    [run.session_id],
  );

  assert.equal(classificationsStored.rows.length, 1);
  assert.equal(classificationsStored.rows[0].outcome, 'ALLOW');
  assert.equal(classificationsStored.rows[0].primary_category, null);
  assert.equal(classificationsStored.rows[0].severity, 0);
  assert.equal(classificationsStored.rows[0].classifier_version, 'rules-1');
  assert.equal(classificationsStored.rows[0].policy_version, 'policy-1');
  const firstPlans = await readPlans(run);
  assert.equal(firstPlans.length, 1);
  assert.equal(firstPlans[0].action, 'NONE');
  assert.equal(firstPlans[0].policy_version, `settings-run-${run.id}`);
  assert.equal(refreshCalls, 1);
  assert.equal(chatCalls, 1);

  assert.equal((await statusOf(run)).status, 'RUNNING');

  const waiting = await worker.coordinator.tick();
  assert.equal(waiting.kind, 'IDLE');
  assert.equal(chatCalls, 1);

  await makeDue(run);

  const second = await worker.coordinator.tick();
  assert.equal(second.kind, 'POLLED');
  assert.equal(second.inserted, 0);
  assert.equal(refreshCalls, 1);
  assert.equal(chatCalls, 2);

  const stored = await admin.query(
    `
      SELECT count(*)::int AS total
      FROM youtube_chat_observations
      WHERE session_id = $1
    `,
    [run.session_id],
  );
  assert.equal(stored.rows[0].total, 1);
  assert.deepEqual(await readPlans(run), firstPlans);

  const stopping = await stopThroughApi(run);
  assert.equal(stopping.status, 'STOPPING');

  // Stop must be selected even while the next polling time is in the future.
  assert.equal((await worker.coordinator.tick()).kind, 'STOPPED');
  assert.equal((await statusOf(run)).status, 'STOPPED');
  assert.equal(chatCalls, 2);

  assert.equal((await worker.coordinator.tick()).kind, 'IDLE');
});

test('a replacement coordinator recovers an expired lease without duplicate observations', async () => {
  const firstWorker = createWorker();
  const run = await startRun();

  assert.equal((await firstWorker.coordinator.tick()).kind, 'POLLED');

  const abandoned = await firstWorker.leases.claim(run.id, randomUUID());
  assert.ok(abandoned);

  await makeDue(run);

  const replacement = createWorker();

  // A live lease must exclude the run from candidate selection.
  assert.equal((await replacement.coordinator.tick()).kind, 'IDLE');

  await admin.query(
    `
      UPDATE monitoring_worker_leases
      SET
        acquired_at = '2020-01-01T00:00:00Z',
        heartbeat_at = '2020-01-01T00:00:01Z',
        expires_at = '2020-01-01T00:00:02Z'
      WHERE run_id = $1
    `,
    [run.id],
  );

  const resumed = await replacement.coordinator.tick();
  assert.equal(resumed.kind, 'POLLED');
  assert.equal(resumed.inserted, 0);

  await assert.rejects(firstWorker.leases.heartbeat(abandoned), LeaseLostError);

  const checkpoint = await admin.query(
    `
      SELECT revision::text, next_page_token
      FROM youtube_chat_checkpoints
      WHERE session_id = $1
    `,
    [run.session_id],
  );

  assert.equal(checkpoint.rows[0].revision, '2');
  assert.equal(checkpoint.rows[0].next_page_token, 'page-3');

  const observations = await admin.query(
    'SELECT id FROM youtube_chat_observations WHERE session_id = $1',
    [run.session_id],
  );
  assert.equal(observations.rows.length, 1);
  assert.equal((await readPlans(run)).length, 1);

  await stopThroughApi(run);
  assert.equal((await replacement.coordinator.tick()).kind, 'STOPPED');
  assert.equal((await replacement.coordinator.tick()).kind, 'IDLE');
});

test('action plan failure rolls back the entire ingestion batch and permits retry', async () => {
  const failure = new Error('Injected action plan failure');
  const realStore = new ActionPlanStore();
  const worker = createWorker({
    async save(client, plan) {
      await realStore.save(client, plan);
      throw failure;
    },
  });
  const run = await startRun();
  const lease = await worker.leases.claim(run.id, randomUUID());
  assert.ok(lease);
  const checkpoint = await worker.writer.checkpoint(lease);
  const broadcast = broadcasts.get(run.youtube_broadcast_id);
  const batch = {
    expected_revision: checkpoint.revision,
    request_page_token: checkpoint.next_page_token,
    next_page_token: 'rollback-page-2',
    polling_interval_ms: 60000,
    items: [
      {
        id: 'rollback-message',
        snippet: {
          type: 'textMessageEvent',
          liveChatId: broadcast.live_chat_id,
          publishedAt: '2026-01-01T00:00:00Z',
          textMessageDetails: { messageText: 'contoh kata idiot' },
        },
        authorDetails: { channelId: 'test-author', displayName: 'Test viewer' },
      },
    ],
  };
  const beforeEvents = await admin.query(
    'SELECT sequence::text, event_type FROM live_events WHERE session_id = $1 ORDER BY sequence',
    [run.session_id],
  );
  await assert.rejects(worker.writer.commit(lease, batch), (error) => error === failure);
  for (const table of [
    'youtube_chat_observations',
    'youtube_chat_classifications',
    'youtube_moderation_action_plans',
  ]) {
    const result = await admin.query(
      `SELECT count(*)::int AS total FROM ${table} WHERE session_id = $1`,
      [run.session_id],
    );
    assert.equal(result.rows[0].total, 0, table);
  }
  const afterCheckpoint = await worker.writer.checkpoint(lease);
  assert.equal(afterCheckpoint.revision, checkpoint.revision);
  assert.equal(afterCheckpoint.next_page_token, checkpoint.next_page_token);
  assert.equal((await statusOf(run)).status, 'STARTING');
  const afterEvents = await admin.query(
    'SELECT sequence::text, event_type FROM live_events WHERE session_id = $1 ORDER BY sequence',
    [run.session_id],
  );
  assert.deepEqual(afterEvents.rows, beforeEvents.rows);

  const healthy = new BatchWriter(worker.leases, createClassificationStore());
  assert.equal((await healthy.commit(lease, batch)).inserted, 1);
  const plans = await readPlans(run);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].action, 'NONE');
  const classified = await admin.query(
    'SELECT outcome FROM youtube_chat_classifications WHERE session_id = $1',
    [run.session_id],
  );
  assert.equal(classified.rows[0].outcome, 'REVIEW');
  await worker.leases.finish(lease, 'STOPPED');
});

test('concurrent action plan saves reuse one row under the worker role', async () => {
  const worker = createWorker();
  const run = await startRun();
  assert.equal((await worker.coordinator.tick()).kind, 'POLLED');
  const [original] = await readPlans(run);
  const plan = {
    classification_id: original.classification_id,
    channel_id: run.channel_id,
    session_id: run.session_id,
    policy_version: 'actions-concurrency-1',
    action: 'NONE',
    reason: 'Concurrent replay test.',
  };
  const save = async () => {
    const client = await workerPool.connect();
    try {
      await client.query('BEGIN');
      const result = await new ActionPlanStore().save(client, plan);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  const settled = await Promise.allSettled([save(), save()]);
  const results = settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  assert.equal(results[0].id, results[1].id);
  assert.deepEqual(results.map((result) => result.reused).sort(), [false, true]);
  assert.equal(
    (await readPlans(run)).filter((entry) => entry.policy_version === plan.policy_version).length,
    1,
  );
  await stopThroughApi(run);
  assert.equal((await worker.coordinator.tick()).kind, 'STOPPED');
});

test('worker plans saved actions from the run snapshot despite later settings changes', async () => {
  for (const action of ['DELETE', 'TIMEOUT', 'BAN']) {
    const initial = await startRun();
    assert.equal((await stopThroughApi(initial)).status, 'STOPPED');
    const configuration = {
      schema_version: 1,
      automatic_actions_enabled: true,
      rules: [
        {
          rule_id: 'id.harassment.direct-insult',
          rule_version: '1',
          minimum_severity: 2,
          action,
          ...(action === 'TIMEOUT' ? { duration_seconds: 30 } : {}),
        },
      ],
    };
    const settingsPath = `/v1/channels/${initial.channel_id}/moderation-settings`;
    const saved = await request(settingsPath, {
      method: 'POST',
      body: { expected_revision: 0, configuration },
    });
    assert.equal(saved.status, 200, await saved.clone().text());

    const start = await request('/v1/monitoring/start', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { youtube_broadcast_id: initial.youtube_broadcast_id },
    });
    assert.equal(start.status, 200, await start.clone().text());
    const run = startMonitoringResponse.parse(await start.json()).run;
    const worker = createWorker();
    const lease = await worker.leases.claim(run.id, randomUUID());
    assert.ok(lease);
    const broadcast = broadcasts.get(run.youtube_broadcast_id);
    const authorId = 'UC' + 'a'.repeat(22);
    const commit = async (messageId, text) => {
      const checkpoint = await worker.writer.checkpoint(lease);
      return worker.writer.commit(lease, {
        expected_revision: checkpoint.revision,
        request_page_token: checkpoint.next_page_token,
        next_page_token: `next-${messageId}`,
        polling_interval_ms: 60000,
        items: [
          {
            id: messageId,
            snippet: {
              type: 'textMessageEvent',
              liveChatId: broadcast.live_chat_id,
              publishedAt: '2026-01-01T00:00:00Z',
              textMessageDetails: { messageText: text },
            },
            authorDetails: { channelId: authorId, displayName: 'Test viewer' },
          },
        ],
      });
    };
    assert.equal((await commit('first', 'idiot')).inserted, 1);
    const changed = await request(settingsPath, {
      method: 'POST',
      body: {
        expected_revision: 1,
        configuration: { schema_version: 1, automatic_actions_enabled: false, rules: [] },
      },
    });
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.equal((await commit('second', 'idiot')).inserted, 1);
    assert.equal((await commit('safe', 'Hello test')).inserted, 1);
    const stored = await admin.query(
      `SELECT o.external_message_id, p.action, p.duration_seconds::text, p.policy_version
       FROM youtube_moderation_action_plans p
       JOIN youtube_chat_classifications c ON c.id = p.classification_id
       JOIN youtube_chat_observations o ON o.id = c.observation_id
       WHERE c.run_id = $1 ORDER BY o.external_message_id`,
      [run.id],
    );
    assert.equal(stored.rows.length, 3);
    for (const plan of stored.rows) {
      assert.equal(plan.action, plan.external_message_id === 'safe' ? 'NONE' : action);
      assert.equal(plan.policy_version, `settings-run-${run.id}`);
      assert.equal(
        plan.duration_seconds,
        action === 'TIMEOUT' && plan.external_message_id !== 'safe' ? '30' : null,
      );
    }
    // Reading snapshots is allowed, but the worker cannot edit their configuration.
    const permissions = await workerPool.query(`SELECT
      has_table_privilege(current_user, 'monitoring_settings_snapshots', 'SELECT') AS readable,
      has_table_privilege(current_user, 'monitoring_settings_snapshots', 'UPDATE') AS editable`);
    assert.deepEqual(permissions.rows[0], { readable: true, editable: false });
    await worker.leases.finish(lease, 'STOPPED');

    const restart = await request('/v1/monitoring/start', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { youtube_broadcast_id: run.youtube_broadcast_id },
    });
    assert.equal(restart.status, 200, await restart.clone().text());
    const restarted = startMonitoringResponse.parse(await restart.json()).run;
    const newLease = await worker.leases.claim(restarted.id, randomUUID());
    assert.ok(newLease);
    const checkpoint = await worker.writer.checkpoint(newLease);
    await worker.writer.commit(newLease, {
      expected_revision: checkpoint.revision,
      request_page_token: checkpoint.next_page_token,
      next_page_token: 'disabled-page',
      polling_interval_ms: 60000,
      items: [
        {
          id: 'disabled',
          snippet: {
            type: 'textMessageEvent',
            liveChatId: broadcast.live_chat_id,
            publishedAt: '2026-01-01T00:00:01Z',
            textMessageDetails: { messageText: 'idiot' },
          },
          authorDetails: { channelId: authorId, displayName: 'Test viewer' },
        },
      ],
    });
    const disabled = await admin.query(
      `SELECT p.action, p.policy_version FROM youtube_moderation_action_plans p
       JOIN youtube_chat_classifications c ON c.id = p.classification_id
       WHERE c.run_id = $1`,
      [restarted.id],
    );
    assert.deepEqual(disabled.rows, [
      { action: 'NONE', policy_version: `settings-run-${restarted.id}` },
    ]);
    await worker.leases.finish(newLease, 'STOPPED');
  }
});
