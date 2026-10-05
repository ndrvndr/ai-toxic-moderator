const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');
const { createApi } = source('apps/api/src/app.ts');
const { UNBAN_PROVIDER } = source('apps/api/src/unban/unban.module.ts');
const { loadConfig } = source('packages/config/src/index.ts');
const { unbanResponse, unbanHistory } = source('packages/contracts/src/unban.ts');
const schema = `unban_http_${randomUUID().replaceAll('-', '')}`;
const role = `unban_api_${randomUUID().replaceAll('-', '')}`;
const owner = randomUUID(),
  origin = 'http://127.0.0.1:3000';
let admin,
  pool,
  app,
  base,
  ports,
  calls,
  tokenCalls,
  created = false,
  roleCreated = false;
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw Error('Set TEST_DATABASE_URL to an admin-capable local test database.');
  admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await admin.query(`SET search_path TO ${schema}`);
  const { migrate } = await import('../scripts/database.mjs');
  await migrate(admin);
  const { provisionRuntimeRole } = await import('../scripts/runtime-role.mjs');
  await provisionRuntimeRole(admin, { role, password: randomUUID(), schema });
  roleCreated = true;
  await admin.query("INSERT INTO accounts(id,display_name) VALUES($1,'Unban HTTP owner')", [owner]);
  pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${role}`,
    max: 5,
    statement_timeout: 10000,
  });
  app = await createApi(
    loadConfig({
      DATABASE_URL: url,
      NODE_ENV: 'test',
      DEV_AUTH_ENABLED: 'true',
      DEV_ACCOUNT_ID: owner,
      DASHBOARD_ORIGIN: origin,
      GOOGLE_AUTH_ENABLED: 'true',
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'fixture-only',
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    }),
    pool,
  );
  ports = app.get(UNBAN_PROVIDER);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
beforeEach(() => {
  calls = [];
  tokenCalls = [];
  ports.accessToken = async (account) => {
    tokenCalls.push(account);
    return 'fixture-access';
  };
  ports.removeBan = async (input) => {
    calls.push(input);
    return { status: 'SUCCEEDED', http_status: 204 };
  };
});
after(async () => {
  try {
    if (app) await app.close();
    else if (pool) await pool.end();
  } finally {
    if (admin) {
      try {
        if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        if (roleCreated) await admin.query(`DROP ROLE ${role}`);
      } finally {
        await admin.end();
      }
    }
  }
});
async function cookie(account = owner) {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await admin.query(
    "INSERT INTO dashboard_sessions(id,account_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
    [randomUUID(), account, hash],
  );
  return { cookie: `atm_dev_session=${token}`, hash };
}
async function fixture(action = 'BAN', outcome = 'SUCCEEDED') {
  const f = {
    channel: randomUUID(),
    session: randomUUID(),
    run: randomUUID(),
    observation: randomUUID(),
    classification: randomUUID(),
    plan: randomUUID(),
    execution: randomUUID(),
    attempt: randomUUID(),
  };
  await admin.query("INSERT INTO channels(id,display_name) VALUES($1,'Unban channel')", [
    f.channel,
  ]);
  await admin.query(
    "INSERT INTO channel_memberships(channel_id,account_id,role) VALUES($1,$2,'OWNER')",
    [f.channel, owner],
  );
  await admin.query('INSERT INTO youtube_channels(channel_id,youtube_channel_id) VALUES($1,$2)', [
    f.channel,
    `channel-${f.channel}`,
  ]);
  await admin.query(
    "INSERT INTO stream_sessions(id,channel_id,label,source) VALUES($1,$2,'Unban test','YOUTUBE')",
    [f.session, f.channel],
  );
  await admin.query(
    'INSERT INTO youtube_broadcasts(session_id,channel_id,youtube_broadcast_id,live_chat_id) VALUES($1,$2,$3,$4)',
    [f.session, f.channel, `broadcast-${f.run}`, `chat-${f.run}`],
  );
  await admin.query(
    'INSERT INTO monitoring_runs(id,channel_id,session_id,requested_by_account_id,credential_account_id) VALUES($1,$2,$3,$4,$4)',
    [f.run, f.channel, f.session, owner],
  );
  await admin.query(
    `INSERT INTO youtube_chat_observations(id,channel_id,session_id,first_observed_run_id,external_message_id,event_type,published_at,payload,payload_hash)
    VALUES($1,$2,$3,$4,$5,'textMessageEvent',clock_timestamp(),' {"authorDetails":{"channelId":"fixture-viewer"}}'::jsonb,$6)`,
    [f.observation, f.channel, f.session, f.run, `msg-${f.observation}`, 'a'.repeat(64)],
  );
  await admin.query(
    `INSERT INTO youtube_chat_classifications(id,channel_id,session_id,observation_id,run_id,classifier_version,policy_version,outcome,primary_category,severity,reason_code,reason,signals)
    VALUES($1,$2,$3,$4,$5,'fixture','fixture','REVIEW','HARASSMENT',2,'DIRECT_INSULT','Fixture only.','[]'::jsonb)`,
    [f.classification, f.channel, f.session, f.observation, f.run],
  );
  await admin.query(
    `INSERT INTO youtube_moderation_action_plans(id,channel_id,session_id,classification_id,policy_version,action,reason,duration_seconds)
    VALUES($1,$2,$3,$4,'fixture',$5,'Fixture only.',CASE WHEN $5='TIMEOUT' THEN 30 ELSE NULL END)`,
    [f.plan, f.channel, f.session, f.classification, action],
  );
  await admin.query(
    `INSERT INTO youtube_ban_executions(id,plan_id,channel_id,session_id,live_chat_id,author_channel_id,action,duration_seconds)
    VALUES($1,$2,$3,$4,$5,'fixture-viewer',$6,CASE WHEN $6='TIMEOUT' THEN 30 ELSE NULL END)`,
    [f.execution, f.plan, f.channel, f.session, `chat-${f.run}`, action],
  );
  await admin.query(
    `INSERT INTO youtube_ban_attempts(id,execution_id,owner_id,started_at,deadline_at)
    VALUES($1,$2,$3,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`,
    [f.attempt, f.execution, randomUUID()],
  );
  await admin.query(
    `UPDATE youtube_ban_attempts SET status=$2,http_status=CASE WHEN $2='SUCCEEDED' THEN 200 ELSE NULL END,
    ban_id=CASE WHEN $2='SUCCEEDED' THEN $3 ELSE NULL END,error_code=CASE WHEN $2='UNKNOWN' THEN 'TRANSPORT_ERROR' ELSE NULL END,
    finished_at=clock_timestamp()-interval '90 seconds' WHERE id=$1`,
    [f.attempt, outcome, `ban-${f.attempt}`],
  );
  f.auth = await cookie();
  return f;
}
function endpoint(f) {
  return `/v1/channels/${f.channel}/sessions/${f.session}/ban-executions/${f.execution}/unban`;
}
function request(f, body, options = {}) {
  return fetch(base + endpoint(f), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      Cookie: f.auth.cookie,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const intent = (method = 'YOUTUBE') => ({
  request_id: randomUUID(),
  method,
  ...(method === 'STUDIO_CONFIRMATION' ? { confirmed: true } : {}),
});
async function success(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function events(f) {
  return (
    await admin.query(
      'SELECT sequence::text FROM live_events WHERE channel_id=$1 AND session_id=$2 ORDER BY sequence',
      [f.channel, f.session],
    )
  ).rows;
}

test('owner removal uses the stored provider target once, publishes changes and replays safely', async () => {
  const f = await fixture(),
    body = intent();
  assert.deepEqual(unbanHistory.parse(await success(await request(f))), { items: [] });
  const result = unbanResponse.parse(await success(await request(f, body)));
  assert.equal(result.removal.status, 'SUCCEEDED');
  assert.equal(result.reused, false);
  assert.deepEqual(calls, [{ accessToken: 'fixture-access', banId: `ban-${f.attempt}` }]);
  assert.deepEqual(tokenCalls, [owner]);
  const replay = await success(await request(f, body));
  assert.deepEqual(replay, { ...result, reused: true });
  assert.equal(calls.length, 1);
  assert.deepEqual((await success(await request(f))).items, [result.removal]);
  assert.equal((await events(f)).length, 2);
  const original = await admin.query('SELECT status,ban_id FROM youtube_ban_attempts WHERE id=$1', [
    f.attempt,
  ]);
  assert.deepEqual(original.rows[0], { status: 'SUCCEEDED', ban_id: `ban-${f.attempt}` });
});

test('Studio confirmation is user evidence, does not call Google and remains idempotent', async () => {
  const f = await fixture(),
    body = intent('STUDIO_CONFIRMATION');
  const result = await success(await request(f, body));
  assert.equal(result.removal.status, 'USER_CONFIRMED');
  assert.deepEqual(await success(await request(f, body)), { ...result, reused: true });
  assert.equal(calls.length, 0);
  assert.equal(tokenCalls.length, 0);
  assert.equal((await events(f)).length, 1);
  assert.equal((await request(f, intent())).status, 409);
});

test('missing session, invalid Origin, moderator, operator and outsider cannot remove bans', async () => {
  const f = await fixture();
  assert.equal((await request(f, intent(), { headers: { Cookie: '' } })).status, 401);
  assert.equal(
    (await request(f, intent(), { headers: { Origin: 'https://untrusted.example' } })).status,
    403,
  );
  for (const membership of ['MODERATOR', 'OPERATOR', null]) {
    const account = randomUUID();
    await admin.query("INSERT INTO accounts(id,display_name) VALUES($1,'Other')", [account]);
    if (membership)
      await admin.query(
        'INSERT INTO channel_memberships(channel_id,account_id,role) VALUES($1,$2,$3)',
        [f.channel, account, membership],
      );
    const auth = await cookie(account);
    assert.equal((await request({ ...f, auth }, intent())).status, 403);
    assert.equal((await request({ ...f, auth })).status, 403);
  }
  assert.equal(calls.length, 0);
  assert.equal(tokenCalls.length, 0);
});

test('invalid inputs, substituted session and execution, timeout and unknown original ban are rejected', async () => {
  const f = await fixture(),
    other = await fixture();
  for (const body of [
    { ...intent(), ban_id: 'injected' },
    { ...intent('STUDIO_CONFIRMATION'), confirmed: false },
    { ...intent(), request_id: 'bad' },
  ])
    assert.equal((await request(f, body)).status, 422);
  assert.equal((await request({ ...f, session: other.session }, intent())).status, 404);
  assert.equal((await request({ ...f, execution: other.execution }, intent())).status, 404);
  assert.equal((await request({ ...f, execution: 'bad' }, intent())).status, 422);
  for (const invalid of [await fixture('TIMEOUT'), await fixture('BAN', 'UNKNOWN')])
    assert.equal((await request(invalid, intent())).status, 404);
  assert.equal(calls.length, 0);
});

test('request identity cannot be reused for another execution or intent', async () => {
  const f = await fixture(),
    other = await fixture(),
    body = intent('STUDIO_CONFIRMATION');
  await success(await request(f, body));
  assert.equal((await request(other, body)).status, 409);
  assert.equal((await request(f, { request_id: body.request_id, method: 'YOUTUBE' })).status, 409);
});

test('competing requests and replay during dispatch cannot send another provider request', async () => {
  const f = await fixture(),
    body = intent();
  let release, started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  ports.removeBan = async (input) => {
    calls.push(input);
    started();
    await gate;
    return { status: 'SUCCEEDED', http_status: 204 };
  };
  const first = request(f, body);
  try {
    await Promise.race([
      entered,
      first.then((response) => assert.fail(`Dispatch did not begin: HTTP ${response.status}`)),
    ]);
    const replay = await success(await request(f, body));
    assert.equal(replay.reused, true);
    assert.equal(replay.removal.status, 'DISPATCHED');
    assert.equal((await request(f, intent())).status, 409);
    assert.equal(calls.length, 1);
    assert.equal(tokenCalls.length, 1);
  } finally {
    release();
    await success(await first);
  }
});

test('lost provider response remains unknown; explicit Studio confirmation preserves it', async () => {
  const f = await fixture(),
    body = intent();
  ports.removeBan = async (input) => {
    calls.push(input);
    throw Error('fixture-access SQL private details');
  };
  const result = await success(await request(f, body));
  assert.equal(result.removal.status, 'UNKNOWN');
  assert.equal(JSON.stringify(result).includes('fixture-access'), false);
  assert.equal((await success(await request(f, body))).reused, true);
  assert.equal((await request(f, intent())).status, 409);
  assert.equal(calls.length, 1);
  assert.equal(
    (await success(await request(f, intent('STUDIO_CONFIRMATION')))).removal.status,
    'USER_CONFIRMED',
  );
  assert.deepEqual(
    (await success(await request(f))).items.map((row) => row.status),
    ['USER_CONFIRMED', 'UNKNOWN'],
  );
});

test('provider rejection is stored without claiming removal and can be explicitly requested again', async () => {
  const f = await fixture();
  ports.removeBan = async (input) => {
    calls.push(input);
    return { status: 'REJECTED', http_status: 404, code: 'BAN_NOT_FOUND' };
  };
  assert.equal((await success(await request(f, intent()))).removal.status, 'REJECTED');
  assert.equal((await success(await request(f, intent()))).removal.status, 'REJECTED');
  assert.equal(calls.length, 2);
});

test('token failure and revoked access during refresh never dispatch', async () => {
  const f = await fixture();
  ports.accessToken = async () => {
    throw Error('private credentials');
  };
  assert.equal((await success(await request(f, intent()))).removal.status, 'NOT_SENT');
  assert.equal(calls.length, 0);
  ports.accessToken = async () => {
    await admin.query('DELETE FROM dashboard_sessions WHERE token_hash=$1', [f.auth.hash]);
    return 'fixture';
  };
  assert.equal((await success(await request(f, intent()))).removal.status, 'NOT_SENT');
  assert.equal(calls.length, 0);
});

test('membership revoked during refresh prevents dispatch but preserves a not-sent audit result', async () => {
  const f = await fixture();
  ports.accessToken = async () => {
    await admin.query('DELETE FROM channel_memberships WHERE channel_id=$1 AND account_id=$2', [
      f.channel,
      owner,
    ]);
    return 'fixture';
  };
  assert.equal((await success(await request(f, intent()))).removal.status, 'NOT_SENT');
  assert.equal(calls.length, 0);
  assert.equal((await request(f)).status, 403);
});

test('another legitimate owner cannot use the original owner credential but can confirm Studio removal', async () => {
  const f = await fixture();
  const other = randomUUID();
  await admin.query("INSERT INTO accounts(id,display_name) VALUES($1,'Other owner')", [other]);
  await admin.query(
    "INSERT INTO channel_memberships(channel_id,account_id,role) VALUES($1,$2,'OWNER')",
    [f.channel, other],
  );
  f.auth = await cookie(other);
  assert.equal((await request(f, intent())).status, 409);
  assert.equal(tokenCalls.length, 0);
  assert.equal(
    (await success(await request(f, intent('STUDIO_CONFIRMATION')))).removal.status,
    'USER_CONFIRMED',
  );
  assert.equal(calls.length, 0);
});

test('expired dispatched record recovers once on read without redispatch after restart', async () => {
  const f = await fixture();
  await admin.query(
    `INSERT INTO youtube_unban_requests(id,request_id,ban_attempt_id,execution_id,channel_id,session_id,requested_by_account_id,credential_account_id,method,status,requested_at,deadline_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7,'YOUTUBE','DISPATCHED',clock_timestamp()-interval '45 seconds',clock_timestamp()-interval '15 seconds')`,
    [randomUUID(), randomUUID(), f.attempt, f.execution, f.channel, f.session, owner],
  );
  assert.equal((await success(await request(f))).items[0].status, 'UNKNOWN');
  assert.equal((await events(f)).length, 1);
  assert.equal((await success(await request(f))).items[0].status, 'UNKNOWN');
  assert.equal((await events(f)).length, 1);
  assert.equal((await request(f, intent())).status, 409);
  assert.equal(calls.length, 0);
});

test('publication failure rolls back request creation before any provider call', async () => {
  const f = await fixture();
  await admin.query(`REVOKE INSERT ON ${schema}.live_events FROM ${role}`);
  try {
    assert.equal((await request(f, intent())).status, 500);
  } finally {
    await admin.query(`GRANT INSERT ON ${schema}.live_events TO ${role}`);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual((await success(await request(f))).items, []);
});
