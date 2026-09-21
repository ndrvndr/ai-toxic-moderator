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
  chatPage,
  savedSessionsPage,
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

function chatPath(run) {
  return `/v1/channels/${run.channel_id}/sessions/${run.session_id}/chat`;
}

test('chat separates deletion results from classification and preserves uncertain outcomes', async () => {
  for (const status of ['DISPATCHED', 'SUCCEEDED', 'REJECTED', 'NOT_SENT', 'UNKNOWN']) {
    const run = await startRun();
    const observationId = await insertChatObservation(run);
    async function read() {
      const response = await request(chatPath(run));
      assert.equal(response.status, 200, await response.clone().text());
      return chatPage.parse(await response.json()).items[0];
    }
    assert.equal((await read()).deletion, null);
    const classificationId = randomUUID();
    const planId = randomUUID();
    const executionId = randomUUID();
    const attemptId = randomUUID();
    await admin.query(
      `INSERT INTO youtube_chat_classifications(id, channel_id, session_id, observation_id, run_id,
       classifier_version, policy_version, outcome, primary_category, severity, reason_code, reason, signals)
       VALUES($1, $2, $3, $4, $5, 'test-rules', 'test-policy', 'REVIEW', 'HARASSMENT', 2,
       'DIRECT_INSULT', 'Test classification.', '[]'::jsonb)`,
      [classificationId, run.channel_id, run.session_id, observationId, run.id],
    );
    assert.equal((await read()).deletion, null);
    await admin.query(
      `INSERT INTO youtube_moderation_action_plans(id, channel_id, session_id, classification_id, policy_version, action, reason)
       VALUES($1, $2, $3, $4, 'test-actions', 'DELETE', 'Test deletion plan.')`,
      [planId, run.channel_id, run.session_id, classificationId],
    );
    assert.deepEqual((await read()).deletion, { action: 'DELETE', status: 'PENDING' });
    await admin.query(
      `INSERT INTO youtube_delete_executions(id, plan_id, channel_id, session_id, external_message_id)
       VALUES($1, $2, $3, $4, $5)`,
      [executionId, planId, run.channel_id, run.session_id, `message-${observationId}`],
    );
    await admin.query(
      `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
       INSERT INTO youtube_delete_attempts(id, execution_id, attempt_number, owner_id, started_at, deadline_at)
       SELECT $1, $2, 1, $3, at, at + interval '30 seconds' FROM moment`,
      [attemptId, executionId, randomUUID()],
    );
    if (status !== 'DISPATCHED') {
      await admin.query(
        `UPDATE youtube_delete_attempts SET status = $2, finished_at = clock_timestamp(),
         http_status = $3, error_code = $4 WHERE id = $1`,
        [
          attemptId,
          status,
          status === 'SUCCEEDED' ? 204 : status === 'REJECTED' ? 403 : null,
          status === 'SUCCEEDED'
            ? null
            : status === 'REJECTED'
              ? 'YOUTUBE_FORBIDDEN'
              : status === 'NOT_SENT'
                ? 'REQUEST_CANCELLED'
                : 'EXECUTION_DEADLINE_EXCEEDED',
        ],
      );
    }
    const item = await read();
    assert.equal(item.evaluation_status, 'REVIEW');
    assert.deepEqual(item.deletion, { action: 'DELETE', status });
    assert.equal('owner_id' in item.deletion, false);
    assert.equal('error_code' in item.deletion, false);
    const otherRun = await startRun();
    await insertChatObservation(otherRun);
    const otherResponse = await request(chatPath(otherRun));
    assert.equal(otherResponse.status, 200);
    assert.equal(chatPage.parse(await otherResponse.json()).items[0].deletion, null);
  }
});

async function insertChatObservation(
  run,
  {
    id = randomUUID(),
    receivedAt = '2026-01-01T00:00:00.123456Z',
    text = 'Test viewer message',
  } = {},
) {
  await admin.query(
    `
      INSERT INTO youtube_chat_observations(
        id,
        channel_id,
        session_id,
        first_observed_run_id,
        external_message_id,
        event_type,
        published_at,
        received_at,
        payload,
        payload_hash
      )
      VALUES(
        $1, $2, $3, $4, $5, 'textMessageEvent',
        $6, $6, $7::jsonb, $8
      )
    `,
    [
      id,
      run.channel_id,
      run.session_id,
      run.id,
      `message-${id}`,
      receivedAt,
      JSON.stringify({
        snippet: {
          liveChatId: 'internal-chat-identifier',
          textMessageDetails: { messageText: text },
        },
        authorDetails: {
          channelId: 'viewer-channel',
          displayName: 'Test viewer',
        },
      }),
      'a'.repeat(64),
    ],
  );

  return id;
}

test('chat endpoint returns an empty page for an existing session', async () => {
  const run = await startRun();
  const response = await request(chatPath(run));

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(chatPage.parse(await response.json()), {
    items: [],
    next_cursor: null,
  });
});

test('chat pagination preserves microseconds and hides raw provider payload', async () => {
  const run = await startRun();

  const older = await insertChatObservation(run, {
    receivedAt: '2026-01-01T00:00:00.123455Z',
  });
  const newer = await insertChatObservation(run, {
    receivedAt: '2026-01-01T00:00:00.123456Z',
  });

  const firstResponse = await request(`${chatPath(run)}?limit=1`);
  assert.equal(firstResponse.status, 200);
  const first = chatPage.parse(await firstResponse.json());

  assert.equal(first.items[0].id, newer);
  assert.equal(first.items[0].evaluation_status, 'NOT_EVALUATED');
  assert.equal(first.items[0].display_text, 'Test viewer message');
  assert.equal(first.items[0].author_display_name, 'Test viewer');
  assert.ok(first.next_cursor);
  assert.equal(JSON.stringify(first).includes('internal-chat-identifier'), false);
  assert.equal('payload' in first.items[0], false);

  const secondResponse = await request(
    `${chatPath(run)}?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
  );
  assert.equal(secondResponse.status, 200);
  const second = chatPage.parse(await secondResponse.json());

  assert.equal(second.items[0].id, older);
  assert.equal(second.next_cursor, null);
});

test('chat pagination uses observation ID to break timestamp ties', async () => {
  const run = await startRun();
  const ids = [randomUUID(), randomUUID()].sort();

  await insertChatObservation(run, { id: ids[0] });
  await insertChatObservation(run, { id: ids[1] });

  const firstResponse = await request(`${chatPath(run)}?limit=1`);
  assert.equal(firstResponse.status, 200);
  const first = chatPage.parse(await firstResponse.json());

  assert.equal(first.items[0].id, ids[1]);

  const secondResponse = await request(
    `${chatPath(run)}?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
  );
  assert.equal(secondResponse.status, 200);
  const second = chatPage.parse(await secondResponse.json());

  assert.equal(second.items[0].id, ids[0]);
  assert.equal(second.next_cursor, null);
});

test('chat endpoint rejects cross-session cursors and invalid pagination', async () => {
  const firstRun = await startRun();
  const secondRun = await startRun();

  await insertChatObservation(firstRun);
  await insertChatObservation(firstRun);

  const firstResponse = await request(`${chatPath(firstRun)}?limit=1`);
  assert.equal(firstResponse.status, 200);
  const first = chatPage.parse(await firstResponse.json());

  const wrongCursor = await request(
    `${chatPath(secondRun)}?cursor=${encodeURIComponent(first.next_cursor)}`,
  );
  assert.equal(wrongCursor.status, 400);

  assert.equal((await request(`${chatPath(firstRun)}?limit=101`)).status, 422);

  assert.equal(
    (await request(`/v1/channels/${firstRun.channel_id}/sessions/${secondRun.session_id}/chat`))
      .status,
    404,
  );
});

test('chat access requires a session and current channel membership', async () => {
  const run = await startRun();

  assert.equal((await request(chatPath(run), { headers: { Cookie: '' } })).status, 401);

  await admin.query(
    `
      UPDATE channel_memberships
      SET role = 'OPERATOR'
      WHERE channel_id = $1 AND account_id = $2
    `,
    [run.channel_id, accountId],
  );

  assert.equal((await request(chatPath(run))).status, 403);
});

test('broadcast monitoring lookup restores the latest accessible run', async () => {
  const run = await startRun();

  const response = await request(`/v1/youtube/broadcasts/${run.youtube_broadcast_id}/monitoring`);

  assert.equal(response.status, 200);
  const data = monitoringStatusResponse.parse(await response.json());
  assert.equal(data.run.id, run.id);
});

test('broadcast monitoring lookup does not expose inaccessible runs', async () => {
  const run = await startRun();

  await admin.query('DELETE FROM channel_memberships WHERE channel_id = $1 AND account_id = $2', [
    run.channel_id,
    accountId,
  ]);

  const response = await request(`/v1/youtube/broadcasts/${run.youtube_broadcast_id}/monitoring`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { run: null });
});

test('start and stop publish events without duplicates from repeated requests', async () => {
  const broadcast = registerBroadcast();
  const requestKey = randomUUID();

  const start = () =>
    request('/v1/monitoring/start', {
      method: 'POST',
      headers: { 'Idempotency-Key': requestKey },
      body: {
        youtube_broadcast_id: broadcast.youtube_broadcast_id,
      },
    });

  const first = await start();
  assert.equal(first.status, 200);
  const { run } = startMonitoringResponse.parse(await first.json());

  assert.equal((await start()).status, 200);

  for (let attempt = 0; attempt < 2; attempt++) {
    const stopped = await request(`${runPath(run)}/stop`, {
      method: 'POST',
      body: {},
    });
    assert.equal(stopped.status, 200);
  }

  const events = await admin.query(
    `
      SELECT sequence::text, event_type
      FROM live_events
      WHERE session_id = $1
      ORDER BY sequence
    `,
    [run.session_id],
  );

  assert.deepEqual(events.rows, [
    { sequence: '1', event_type: 'monitoring.updated' },
    { sequence: '2', event_type: 'monitoring.updated' },
  ]);
});

test('saved sessions require authentication', async () => {
  const response = await request('/v1/youtube/sessions', {
    headers: { Cookie: '' },
  });

  assert.equal(response.status, 401);
});

test('saved sessions are readable with the runtime role and omit provider secrets', async () => {
  const run = await startRun();

  const response = await request('/v1/youtube/sessions?limit=50');

  assert.equal(response.status, 200, await response.clone().text());

  const body = await response.json();
  const page = savedSessionsPage.parse(body);
  const item = page.items.find((entry) => entry.session_id === run.session_id);

  assert.ok(item);
  assert.equal(item.channel_id, run.channel_id);
  assert.equal(item.youtube_broadcast_id, run.youtube_broadcast_id);
  assert.equal(item.latest_status, 'STARTING');
  assert.equal('live_chat_id' in item, false);
  assert.equal('credential_account_id' in item, false);

  assert.equal(JSON.stringify(body).includes('access_token'), false);
  assert.equal(JSON.stringify(body).includes('refresh_token'), false);
});

test('saved sessions exclude operator and removed memberships', async () => {
  const run = await startRun();

  await admin.query(
    `
      UPDATE channel_memberships
      SET role = 'OPERATOR'
      WHERE channel_id = $1 AND account_id = $2
    `,
    [run.channel_id, accountId],
  );

  for (const remove of [false, true]) {
    if (remove) {
      await admin.query(
        `
          DELETE FROM channel_memberships
          WHERE channel_id = $1 AND account_id = $2
        `,
        [run.channel_id, accountId],
      );
    }

    const response = await request('/v1/youtube/sessions?limit=50');
    assert.equal(response.status, 200);

    const page = savedSessionsPage.parse(await response.json());

    assert.equal(
      page.items.some((entry) => entry.session_id === run.session_id),
      false,
    );
  }
});

test('saved session pagination returns each accessible session once', async () => {
  await startRun();
  await startRun();

  const expected = await admin.query(
    `
      SELECT s.id
      FROM stream_sessions s
      JOIN youtube_broadcasts b
        ON b.session_id = s.id AND b.channel_id = s.channel_id
      JOIN channel_memberships m
        ON m.channel_id = s.channel_id
      WHERE m.account_id = $1
        AND m.role IN ('OWNER', 'MODERATOR')
      ORDER BY s.created_at DESC, s.id DESC
    `,
    [accountId],
  );

  const collected = [];
  let cursor = null;
  let pages = 0;

  do {
    const query = new URLSearchParams({ limit: '2' });
    if (cursor) query.set('cursor', cursor);

    const response = await request(`/v1/youtube/sessions?${query}`);
    assert.equal(response.status, 200);

    const page = savedSessionsPage.parse(await response.json());

    collected.push(...page.items.map((item) => item.session_id));
    cursor = page.next_cursor;
    pages += 1;

    assert.ok(pages <= 100, 'Pagination must terminate.');
  } while (cursor);

  assert.deepEqual(
    collected,
    expected.rows.map((row) => row.id),
  );
});

test('saved sessions reject malformed pagination and another account cursor', async () => {
  assert.equal((await request('/v1/youtube/sessions?limit=51')).status, 422);

  assert.equal((await request('/v1/youtube/sessions?cursor=invalid')).status, 400);

  const cursor = Buffer.from(
    JSON.stringify({
      account_id: randomUUID(),
      created_at: '2026-01-01T00:00:00.000000Z',
      session_id: randomUUID(),
    }),
  ).toString('base64url');

  const response = await request(`/v1/youtube/sessions?cursor=${encodeURIComponent(cursor)}`);

  assert.equal(response.status, 400);
});
