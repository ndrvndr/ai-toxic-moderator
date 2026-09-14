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

const schema = `monitoring_http_${randomUUID().replaceAll('-', '')}`;
const runtimeRole = `atm_http_${randomUUID().replaceAll('-', '')}`;
const accountId = randomUUID();
const origin = 'http://127.0.0.1:3000';
const broadcasts = new Map();

let admin;
let pool;
let app;
let base;
let cookie;
let schemaCreated = false;
let roleCreated = false;

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
    if (app) await app.close();
    else if (pool) await pool.end();
  } finally {
    if (admin) {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        if (roleCreated) await admin.query(`DROP ROLE ${runtimeRole}`);
      } finally {
        await admin.end();
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

test('start requires authentication, a trusted origin and an idempotency key', async () => {
  const body = { youtube_broadcast_id: 'test-broadcast' };

  const unauthenticated = await request('/v1/monitoring/start', {
    method: 'POST',
    body,
    headers: { Cookie: '', 'Idempotency-Key': randomUUID() },
  });
  assert.equal(unauthenticated.status, 401);

  const untrusted = await request('/v1/monitoring/start', {
    method: 'POST',
    body,
    headers: {
      Origin: 'https://untrusted.invalid',
      'Idempotency-Key': randomUUID(),
    },
  });
  assert.equal(untrusted.status, 403);

  const missingKey = await request('/v1/monitoring/start', {
    method: 'POST',
    body,
  });
  assert.equal(missingKey.status, 422);
});

test('runtime role can start, read and cancel a STARTING run', async () => {
  const run = await startRun();

  const status = await request(runPath(run));
  assert.equal(status.status, 200);
  assert.equal(monitoringStatusResponse.parse(await status.json()).run.status, 'STARTING');

  const stopped = await request(`${runPath(run)}/stop`, {
    method: 'POST',
    body: {},
  });

  assert.equal(stopped.status, 200, await stopped.clone().text());
  const first = stopMonitoringResponse.parse(await stopped.json());

  assert.equal(first.run.status, 'STOPPED');
  assert.equal(first.run.started_at, null);
  assert.ok(first.run.stop_requested_at);
  assert.ok(first.run.finished_at);

  const repeated = await request(`${runPath(run)}/stop`, {
    method: 'POST',
    body: {},
  });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), first);

  const stored = await admin.query(
    'SELECT stopped_by_account_id FROM monitoring_runs WHERE id = $1',
    [run.id],
  );
  assert.equal(stored.rows[0].stopped_by_account_id, accountId);
});

test('stopping a RUNNING run waits for worker confirmation', async () => {
  const run = await startRun();

  await admin.query(
    `
      UPDATE monitoring_runs
      SET status = 'RUNNING', started_at = clock_timestamp()
      WHERE id = $1
    `,
    [run.id],
  );

  const response = await request(`${runPath(run)}/stop`, {
    method: 'POST',
    body: {},
  });

  assert.equal(response.status, 200);
  const stopped = stopMonitoringResponse.parse(await response.json());
  assert.equal(stopped.run.status, 'STOPPING');
  assert.equal(stopped.run.finished_at, null);

  const repeated = await request(`${runPath(run)}/stop`, {
    method: 'POST',
    body: {},
  });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), stopped);
});

test('concurrent stop requests preserve the same completion timestamps', async () => {
  const run = await startRun();

  const responses = await Promise.all(
    Array.from({ length: 4 }, () => request(`${runPath(run)}/stop`, { method: 'POST', body: {} })),
  );

  for (const response of responses) assert.equal(response.status, 200);

  const results = await Promise.all(responses.map((response) => response.json()));
  for (const result of results) assert.deepEqual(result, results[0]);
});

test('a run cannot be read or stopped through another channel', async () => {
  const first = await startRun();
  const second = await startRun();
  const wrongPath = `/v1/channels/${second.channel_id}/monitoring/${first.id}`;

  assert.equal((await request(wrongPath)).status, 404);
  assert.equal((await request(`${wrongPath}/stop`, { method: 'POST', body: {} })).status, 404);

  const stored = await admin.query('SELECT status FROM monitoring_runs WHERE id = $1', [first.id]);
  assert.equal(stored.rows[0].status, 'STARTING');
});

test('operator membership cannot read or stop monitoring', async () => {
  const run = await startRun();

  await admin.query(
    `
      UPDATE channel_memberships
      SET role = 'OPERATOR'
      WHERE channel_id = $1 AND account_id = $2
    `,
    [run.channel_id, accountId],
  );

  assert.equal((await request(runPath(run))).status, 403);
  assert.equal((await request(`${runPath(run)}/stop`, { method: 'POST', body: {} })).status, 403);
});

test('stop rejects client-supplied actor and status fields', async () => {
  const run = await startRun();

  const response = await request(`${runPath(run)}/stop`, {
    method: 'POST',
    body: { stopped_by_account_id: randomUUID(), status: 'STOPPED' },
  });

  assert.equal(response.status, 422);

  const status = await request(runPath(run));
  assert.equal((await status.json()).run.status, 'STARTING');
});
