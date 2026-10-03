const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { Client, Pool } = require('pg');

const { createApi } = require('../apps/api/dist/app');
const { loadConfig } = require('@moderator/config');
const { customBlacklistResponse } = require('@moderator/contracts');

const schema = `blacklist_http_${randomUUID().replaceAll('-', '')}`;
const runtimeRole = `blacklist_http_api_${randomUUID().replaceAll('-', '')}`;
const ownerId = randomUUID();
const origin = 'http://127.0.0.1:3000';
const disabled = { schema_version: 1, enabled: false, rules: [] };
let admin;
let pool;
let app;
let base;
let ownerCookie;
let schemaCreated = false;
let roleCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Set TEST_DATABASE_URL to an admin-capable local test database.');
  }
  const { migrate } = await import('../scripts/database.mjs');
  const { provisionRuntimeRole } = await import('../scripts/runtime-role.mjs');
  admin = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await admin.query(`SET search_path TO ${schema}`);
  await migrate(admin);
  await admin.query('INSERT INTO accounts(id, display_name) VALUES ($1, $2)', [
    ownerId,
    'Blacklist HTTP owner',
  ]);
  await provisionRuntimeRole(admin, { role: runtimeRole, password: randomUUID(), schema });
  roleCreated = true;
  pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${runtimeRole}`,
    max: 4,
    statement_timeout: 10000,
    connectionTimeoutMillis: 3000,
  });
  app = await createApi(
    loadConfig({
      DATABASE_URL: url,
      NODE_ENV: 'test',
      DEV_AUTH_ENABLED: 'true',
      DEV_ACCOUNT_ID: ownerId,
      DASHBOARD_ORIGIN: origin,
    }),
    pool,
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  const login = await fetch(base + '/v1/auth/dev-session', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(login.status, 201, await login.clone().text());
  ownerCookie = login.headers.get('set-cookie').split(';')[0];
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

function endpoint(channelId) {
  return `/v1/channels/${channelId}/blacklist`;
}

function request(url, { cookie = ownerCookie, method = 'GET', body, headers = {} } = {}) {
  return fetch(base + url, {
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

function entry(overrides = {}) {
  return {
    id: randomUUID(),
    enabled: true,
    match_type: 'WORD',
    pattern: 'abc',
    action: 'DELETE',
    ...overrides,
  };
}

function configuration(rules = []) {
  return { schema_version: 1, enabled: true, rules };
}

async function fixture() {
  const channelId = randomUUID();
  await admin.query('INSERT INTO channels(id, display_name) VALUES ($1, $2)', [
    channelId,
    'Blacklist HTTP channel',
  ]);
  await admin.query(
    "INSERT INTO channel_memberships(channel_id, account_id, role) VALUES ($1, $2, 'OWNER')",
    [channelId, ownerId],
  );
  return { channelId, url: endpoint(channelId) };
}

async function viewer(channelId, role) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await admin.query('INSERT INTO accounts(id, display_name) VALUES ($1, $2)', [
    accountId,
    'Blacklist HTTP viewer',
  ]);
  if (role) {
    await admin.query(
      'INSERT INTO channel_memberships(channel_id, account_id, role) VALUES ($1, $2, $3)',
      [channelId, accountId, role],
    );
  }
  await admin.query(
    `INSERT INTO dashboard_sessions(id, account_id, token_hash, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')`,
    [randomUUID(), accountId, hash],
  );
  return { accountId, hash, cookie: `atm_dev_session=${token}` };
}

async function save(f, expected_revision, value = disabled, options = {}) {
  return request(f.url, {
    method: 'POST',
    body: { expected_revision, configuration: value },
    ...options,
  });
}

test('owner reads absent state and saves normalized word, phrase, and domain actions', async () => {
  const f = await fixture();
  const initial = await request(f.url);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.deepEqual(customBlacklistResponse.parse(await initial.json()), { blacklist: null });
  const rules = [
    entry({ pattern: ' ＡＢＣ ', action: 'DELETE_TIMEOUT', duration_seconds: 300 }),
    entry({ match_type: 'PHRASE', pattern: '  CBA   PROMO ', action: 'DELETE_BAN' }),
    entry({ match_type: 'DOMAIN', pattern: 'EXAMPLE.COM' }),
  ];
  const response = await save(f, 0, configuration(rules));
  assert.equal(response.status, 200, await response.clone().text());
  const record = customBlacklistResponse.parse(await response.json()).blacklist;
  assert.equal(record.channel_id, f.channelId);
  assert.equal(record.created_by, ownerId);
  assert.equal(record.revision, 1);
  assert.deepEqual(
    record.configuration.rules.map((rule) => rule.pattern),
    ['abc', 'cba promo', 'example.com'],
  );
  assert.deepEqual(
    record.configuration.rules.map((rule) => rule.action),
    ['DELETE_TIMEOUT', 'DELETE_BAN', 'DELETE'],
  );
  const current = await request(endpoint(f.channelId.toUpperCase()));
  assert.deepEqual(customBlacklistResponse.parse(await current.json()).blacklist, record);
});

test('disabling and removing entries append revisions without rewriting saved history', async () => {
  const f = await fixture();
  const first = customBlacklistResponse.parse(
    await (await save(f, 0, configuration([entry()]))).json(),
  ).blacklist;
  const staged = {
    ...first.configuration,
    enabled: false,
    rules: first.configuration.rules.map((rule) => ({ ...rule, enabled: false })),
  };
  const secondResponse = await save(f, 1, staged);
  assert.equal(secondResponse.status, 200);
  const second = customBlacklistResponse.parse(await secondResponse.json()).blacklist;
  assert.equal(second.revision, 2);
  assert.deepEqual(second.configuration, staged);
  const cleared = await save(f, 2);
  assert.equal(cleared.status, 200);
  assert.equal(customBlacklistResponse.parse(await cleared.json()).blacklist.revision, 3);
  const historical = await admin.query(
    'SELECT configuration FROM channel_custom_blacklists WHERE id = $1',
    [first.id],
  );
  assert.deepEqual(historical.rows[0].configuration, first.configuration);
});

test('moderators can read saved blacklist but only owners can write', async () => {
  const f = await fixture();
  assert.equal((await save(f, 0)).status, 200);
  const actor = await viewer(f.channelId, 'MODERATOR');
  const read = await request(f.url, { cookie: actor.cookie });
  assert.equal(read.status, 200);
  assert.equal(customBlacklistResponse.parse(await read.json()).blacklist.revision, 1);
  const denied = await save(f, 1, disabled, { cookie: actor.cookie });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'BLACKLIST_WRITE_FORBIDDEN');
  assert.equal((await (await request(f.url)).json()).blacklist.revision, 1);
});

test('operators, outsiders, and owners of other channels cannot access blacklist records', async () => {
  const f = await fixture();
  const other = await fixture();
  assert.equal((await save(f, 0, configuration([entry()]))).status, 200);
  for (const actor of [
    await viewer(f.channelId, 'OPERATOR'),
    await viewer(f.channelId),
    await viewer(other.channelId, 'OWNER'),
  ]) {
    for (const response of [
      await request(f.url, { cookie: actor.cookie }),
      await save(f, 1, disabled, { cookie: actor.cookie }),
    ]) {
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.error.code, 'CHANNEL_FORBIDDEN');
      assert.equal(JSON.stringify(body).includes('configuration'), false);
    }
  }
  assert.equal((await (await request(other.url)).json()).blacklist, null);
});

test('missing, expired, and revoked sessions cannot read or mutate blacklist', async () => {
  const f = await fixture();
  const expired = await viewer(f.channelId, 'OWNER');
  const revoked = await viewer(f.channelId, 'OWNER');
  await admin.query(
    `UPDATE dashboard_sessions SET created_at = clock_timestamp() - interval '2 hours',
     expires_at = clock_timestamp() - interval '1 hour' WHERE token_hash = $1`,
    [expired.hash],
  );
  await admin.query('DELETE FROM dashboard_sessions WHERE token_hash = $1', [revoked.hash]);
  for (const cookie of ['', 'atm_dev_session=unknown', expired.cookie, revoked.cookie]) {
    assert.equal((await request(f.url, { cookie })).status, 401);
    assert.equal((await save(f, 0, disabled, { cookie })).status, 401);
  }
  assert.equal((await (await request(f.url)).json()).blacklist, null);
});

test('invalid channel identifiers and untrusted mutation origins are rejected', async () => {
  const f = await fixture();
  for (const url of [endpoint('invalid'), endpoint("' OR 1=1 --")]) {
    assert.equal((await request(url)).status, 422);
    assert.equal(
      (
        await request(url, {
          method: 'POST',
          body: { expected_revision: 0, configuration: disabled },
        })
      ).status,
      422,
    );
  }
  for (const Origin of ['', 'https://untrusted.invalid']) {
    assert.equal((await save(f, 0, disabled, { headers: { Origin } })).status, 403);
  }
  assert.equal((await request(endpoint(randomUUID()))).status, 403);
  assert.equal((await (await request(f.url)).json()).blacklist, null);
});

test('invalid patterns, duplicate entries, duration errors, and ownership injection never persist', async () => {
  const f = await fixture();
  const reference = entry();
  for (const body of [
    {},
    { expected_revision: '0', configuration: disabled },
    { expected_revision: 0, configuration: disabled, created_by: randomUUID() },
    { expected_revision: 0, configuration: disabled, channel_id: randomUUID() },
    ...[
      entry({ pattern: ' ' }),
      entry({ pattern: 'two words' }),
      entry({ pattern: 'ab\u200bcd' }),
      entry({ match_type: 'REGEX', pattern: '.*' }),
      entry({ match_type: 'DOMAIN', pattern: 'https://example.com' }),
      entry({ action: 'DELETE_TIMEOUT' }),
      entry({ action: 'DELETE_TIMEOUT', duration_seconds: '30' }),
      entry({ action: 'DELETE_TIMEOUT', duration_seconds: 0 }),
      entry({ action: 'DELETE_BAN', duration_seconds: 30 }),
      entry({ author_channel_id: 'injected-author' }),
      entry({ external_message_id: 'injected-message' }),
    ].map((rule) => ({ expected_revision: 0, configuration: configuration([rule]) })),
    {
      expected_revision: 0,
      configuration: configuration([reference, { ...reference, pattern: 'different' }]),
    },
    {
      expected_revision: 0,
      configuration: configuration([
        reference,
        entry({ pattern: ' ＡＢＣ ', action: 'DELETE_BAN' }),
      ]),
    },
  ]) {
    const response = await request(f.url, { method: 'POST', body });
    assert.equal(response.status, 422, await response.clone().text());
    const error = (await response.json()).error;
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.message, 'Provide valid blacklist settings.');
    assert.ok(error.field_errors.length > 0);
    assert.ok(error.trace_id);
    assert.equal(JSON.stringify(error).includes('injected-author'), false);
  }
  assert.equal((await (await request(f.url)).json()).blacklist, null);
});

test('literal punctuation is stored as data and cannot select another channel through SQL', async () => {
  const f = await fixture();
  const other = await fixture();
  const value = "offer.* ' or 1=1 --";
  const response = await save(
    f,
    0,
    configuration([entry({ match_type: 'PHRASE', pattern: value })]),
  );
  assert.equal(response.status, 200);
  assert.equal(
    customBlacklistResponse.parse(await response.json()).blacklist.configuration.rules[0].pattern,
    value,
  );
  assert.equal((await (await request(other.url)).json()).blacklist, null);
});

test('concurrent and stale updates return a safe conflict and retain only the winning revision', async () => {
  const f = await fixture();
  const responses = await Promise.all([save(f, 0), save(f, 0, configuration([entry()]))]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winner = customBlacklistResponse.parse(
    await responses.find((response) => response.status === 200).json(),
  ).blacklist;
  const conflict = await responses.find((response) => response.status === 409).json();
  assert.equal(conflict.error.code, 'BLACKLIST_REVISION_CONFLICT');
  assert.equal(conflict.error.message, 'Blacklist changed. Reload before saving.');
  assert.ok(conflict.error.trace_id);
  assert.deepEqual(conflict.error.field_errors, []);
  assert.equal(JSON.stringify(conflict).includes('configuration'), false);
  assert.equal((await save(f, 0)).status, 409);
  assert.deepEqual(
    customBlacklistResponse.parse(await (await request(f.url)).json()).blacklist,
    winner,
  );
  assert.equal((await save(f, 1)).status, 200);
});

test('membership changes apply to subsequent requests before validation or conflict checks', async () => {
  const f = await fixture();
  const actor = await viewer(f.channelId, 'OWNER');
  assert.equal((await save(f, 0, disabled, { cookie: actor.cookie })).status, 200);
  await admin.query(
    "UPDATE channel_memberships SET role = 'MODERATOR' WHERE channel_id = $1 AND account_id = $2",
    [f.channelId, actor.accountId],
  );
  assert.equal((await request(f.url, { cookie: actor.cookie })).status, 200);
  const denied = await request(f.url, { cookie: actor.cookie, method: 'POST', body: {} });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'BLACKLIST_WRITE_FORBIDDEN');
  await admin.query('DELETE FROM channel_memberships WHERE channel_id = $1 AND account_id = $2', [
    f.channelId,
    actor.accountId,
  ]);
  assert.equal((await request(f.url, { cookie: actor.cookie })).status, 403);
  assert.equal((await save(f, 1, disabled, { cookie: actor.cookie })).status, 403);
  assert.equal((await (await request(f.url)).json()).blacklist.revision, 1);
});

test('oversized payloads return a safe error without creating a revision', async () => {
  const f = await fixture();
  const response = await save(f, 0, configuration([entry({ pattern: 'x'.repeat(17000) })]));
  assert.equal(response.status, 413);
  const error = (await response.json()).error;
  assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
  assert.ok(error.trace_id);
  assert.equal(JSON.stringify(error).includes('xxxxx'), false);
  assert.equal((await (await request(f.url)).json()).blacklist, null);
});
