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

function createWorker() {
  const leases = new LeaseStore(workerPool);
  const writer = new BatchWriter(leases);

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

test('HTTP start, scheduled ingestion and HTTP stop complete across runtime roles', async () => {
  const worker = createWorker();

  assert.equal((await worker.coordinator.tick()).kind, 'IDLE');

  const run = await startRun();
  assert.equal(run.status, 'STARTING');

  const first = await worker.coordinator.tick();
  assert.equal(first.kind, 'POLLED');
  assert.equal(first.inserted, 1);
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

  await stopThroughApi(run);
  assert.equal((await replacement.coordinator.tick()).kind, 'STOPPED');
  assert.equal((await replacement.coordinator.tick()).kind, 'IDLE');
});
