const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const http = require('node:http');
const { Client, Pool } = require('pg');
const { createApi } = require('../apps/api/dist/app');
const { loadConfig } = require('@moderator/config');
const { meResponse, sessionsPage, apiError } = require('@moderator/contracts');

const schema = 'auth_' + randomUUID().replaceAll('-', '');
const runtimeRole = 'atm_test_' + randomUUID().replaceAll('-', '');
const origin = 'http://127.0.0.1:3000';

let admin, ids, app, base, config;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw Error('Set TEST_DATABASE_URL to local PostgreSQL');

  const host = new URL(process.env.TEST_DATABASE_URL).hostname;

  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) throw Error('Test DB must be local');

  const database = await import('../scripts/database.mjs');

  ids = database.ids;
  admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await database.migrate(admin);
  await database.seed(admin);

  const { provisionRuntimeRole } = await import('../scripts/runtime-role.mjs');

  await provisionRuntimeRole(admin, { role: runtimeRole, password: randomUUID(), schema });

  config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    NODE_ENV: 'test',
    DEV_AUTH_ENABLED: 'true',
    DASHBOARD_ORIGIN: origin,
  });
  await start();
});
async function start(overrides = {}) {
  app = await createApi(
    { ...config, ...overrides },
    new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema} -c role=${runtimeRole}`,
      max: 3,
    }),
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}
after(async () => {
  if (app) await app.close();
  if (admin) {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
    } finally {
      await admin.end();
    }
  }
});
async function request(route, options = {}) {
  return fetch(base + route, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
}
async function login(cookie) {
  const response = await request('/v1/auth/dev-session', {
    method: 'POST',
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: '{}',
  });
  assert.equal(response.status, 201, await response.clone().text());

  return { response, cookie: response.headers.get('set-cookie').split(';')[0] };
}

const channelPath = () => `/v1/channels/${ids.channel}/sessions`;

test('health is public; private endpoints reject missing and forged sessions', async () => {
  assert.equal((await request('/health/live')).status, 200);

  for (const headers of [{}, { Cookie: 'atm_dev_session=' + 'A'.repeat(43) }]) {
    const response = await request('/v1/me', { headers });
    assert.equal(response.status, 401);

    const body = await response.json();
    assert.equal(apiError.safeParse(body).success, true);
    assert.equal(response.headers.get('x-request-id'), body.error.trace_id);
  }
  assert.equal((await request(channelPath())).status, 401);
});

test('login requires explicit trusted origin and rejects client actor', async () => {
  for (const bad of [
    undefined,
    'null',
    'https://evil.invalid',
    origin + '/',
    'http://127.0.0.1:9999',
  ]) {
    const response = await request('/v1/auth/dev-session', {
      method: 'POST',
      headers: bad ? { Origin: bad } : {},
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
  }

  const forged = await request('/v1/auth/dev-session', {
    method: 'POST',
    headers: { Origin: origin },
    body: JSON.stringify({ account_id: randomUUID(), role: 'OWNER' }),
  });
  assert.equal(forged.status, 422);
});

test('login stores only token hash and returns protected session cookie', async () => {
  const { response, cookie } = await login();
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=3600/);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['expires_at']);

  const token = cookie.split('=')[1];
  const rows = await admin.query('SELECT token_hash FROM dashboard_sessions WHERE token_hash=$1', [
    createHash('sha256').update(token).digest('hex'),
  ]);
  assert.equal(rows.rows.length, 1);
  assert.notEqual(rows.rows[0].token_hash, token);

  const me = await request('/v1/me', { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);

  const data = meResponse.parse(await me.json());
  assert.equal(data.account.id, ids.account);
  assert.deepEqual(data.memberships, [{ channel_id: ids.channel, role: 'MODERATOR' }]);

  const sessionList = await request(channelPath(), { headers: { Cookie: cookie } });
  assert.equal(sessionList.status, 200);
  assert.equal(sessionsPage.parse(await sessionList.json()).items[0].id, ids.session);
});

test('rotation revokes the previous cookie; logout revokes the replacement', async () => {
  const first = await login();
  const second = await login(first.cookie);
  assert.notEqual(first.cookie, second.cookie);
  assert.equal((await request('/v1/me', { headers: { Cookie: first.cookie } })).status, 401);
  assert.equal(
    (
      await request('/v1/auth/logout', {
        method: 'POST',
        headers: { Cookie: second.cookie, Origin: 'https://evil.invalid' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal((await request('/v1/me', { headers: { Cookie: second.cookie } })).status, 200);

  const logout = await request('/v1/auth/logout', {
    method: 'POST',
    headers: { Cookie: second.cookie, Origin: origin },
    body: '{}',
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/v1/me', { headers: { Cookie: second.cookie } })).status, 401);
});

test('expiration and ambiguous duplicate cookies fail closed', async () => {
  const { cookie } = await login();
  assert.equal(
    (await request('/v1/me', { headers: { Cookie: cookie + '; ' + cookie } })).status,
    401,
  );

  const hash = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  await admin.query(
    "UPDATE dashboard_sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE token_hash=$1",
    [hash],
  );
  assert.equal((await request('/v1/me', { headers: { Cookie: cookie } })).status, 401);
});

test('membership is checked for every channel request; operator has no content permission', async () => {
  const { cookie } = await login();
  assert.equal(
    (await request(`/v1/channels/${randomUUID()}/sessions`, { headers: { Cookie: cookie } }))
      .status,
    403,
  );
  assert.equal(
    (await request('/v1/channels/invalid/sessions', { headers: { Cookie: cookie } })).status,
    422,
  );

  try {
    await admin.query(
      "UPDATE channel_memberships SET role='OPERATOR' WHERE channel_id=$1 AND account_id=$2",
      [ids.channel, ids.account],
    );
    assert.equal((await request(channelPath(), { headers: { Cookie: cookie } })).status, 403);

    await admin.query('DELETE FROM channel_memberships WHERE channel_id=$1 AND account_id=$2', [
      ids.channel,
      ids.account,
    ]);
    assert.equal((await request(channelPath(), { headers: { Cookie: cookie } })).status, 403);

    const me = await request('/v1/me', { headers: { Cookie: cookie } });
    assert.deepEqual((await me.json()).memberships, []);
  } finally {
    await admin.query(
      "INSERT INTO channel_memberships(channel_id,account_id,role) VALUES($1,$2,'MODERATOR') ON CONFLICT(channel_id,account_id) DO UPDATE SET role='MODERATOR'",
      [ids.channel, ids.account],
    );
  }
});

test('session persists across API restart; disabling dev auth blocks existing cookies', async () => {
  const { cookie } = await login();
  await app.close();
  await start();
  assert.equal((await request('/v1/me', { headers: { Cookie: cookie } })).status, 200);
  await app.close();
  await start({ DEV_AUTH_ENABLED: false });

  try {
    assert.equal((await request('/v1/me', { headers: { Cookie: cookie } })).status, 401);
    assert.equal(
      (
        await request('/v1/auth/dev-session', {
          method: 'POST',
          headers: { Origin: origin },
          body: '{}',
        })
      ).status,
      404,
    );
  } finally {
    await app.close();
    await start();
  }
});

test('Host spoofing, invalid JSON and oversized bodies are rejected', async () => {
  // fetch normalizes Host; use the HTTP client to send the spoofed wire header.
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(base + '/health/live', { headers: { Host: 'evil.invalid' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);

  for (const [body, status] of [
    ['{', 400],
    [JSON.stringify({ notes: 'x'.repeat(17000) }), 413],
  ]) {
    const result = await request('/v1/auth/dev-session', {
      method: 'POST',
      headers: { Origin: origin },
      body,
    });
    assert.equal(result.status, status);
    assert.equal(apiError.safeParse(await result.json()).success, true);
  }
});

test('CORS preflight supports configured dashboard with credentials', async () => {
  const response = await request('/v1/auth/dev-session', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('session pagination preserves timestamp precision and cursor channel scope', async () => {
  const session = randomUUID(),
    run = randomUUID();
  await admin.query(
    "INSERT INTO stream_sessions(id,channel_id,label,created_at) VALUES($1,$2,'second session','2020-01-01T00:00:00.123456Z')",
    [session, ids.channel],
  );
  await admin.query(
    "INSERT INTO evaluation_runs(id,channel_id,session_id,configuration_bundle_id,kind,mode) VALUES($1,$2,$3,$4,'PRIMARY','SIMULATION')",
    [run, ids.channel, session, ids.bundle],
  );
  const { cookie } = await login();
  const options = { headers: { Cookie: cookie } };
  const first = await (await request(channelPath() + '?limit=1', options)).json();
  assert.equal(first.items.length, 1);
  assert.ok(first.next_cursor);

  const second = await (
    await request(channelPath() + '?limit=1&cursor=' + first.next_cursor, options)
  ).json();
  assert.equal(second.items[0].id, session);
  assert.equal(second.next_cursor, null);

  const cursor = JSON.parse(Buffer.from(first.next_cursor, 'base64url'));
  cursor.channel_id = randomUUID();
  assert.equal(
    (
      await request(
        channelPath() + '?cursor=' + Buffer.from(JSON.stringify(cursor)).toString('base64url'),
        options,
      )
    ).status,
    400,
  );
  assert.equal((await request(channelPath() + '?limit=101', options)).status, 422);
});

test('session storage is bounded per account', async () => {
  for (let i = 0; i < 12; i++) await login();

  const count = await admin.query(
    'SELECT count(*)::int AS n FROM dashboard_sessions WHERE account_id=$1',
    [ids.account],
  );
  assert.equal(count.rows[0].n, 10);
});

test('runtime database role cannot update membership or delete audit history', async () => {
  const runtime = new Client({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema} -c role=${runtimeRole}`,
  });

  await runtime.connect();

  try {
    assert.equal((await runtime.query('SELECT current_user')).rows[0].current_user, runtimeRole);
    await assert.rejects(runtime.query("UPDATE channel_memberships SET role='OWNER'"), {
      code: '42501',
    });
    await assert.rejects(runtime.query('DELETE FROM audit_events'), { code: '42501' });
    await assert.rejects(runtime.query('DELETE FROM moderation_decisions'), { code: '42501' });
  } finally {
    await runtime.end();
  }
});
