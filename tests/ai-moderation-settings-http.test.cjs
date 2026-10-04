const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { Client, Pool } = require('pg');

const { createApi } = require('../apps/api/dist/app');
const { loadConfig } = require('@moderator/config');
const { aiModerationSettingsResponse } = require('@moderator/contracts');

const schema = `ai_settings_http_${randomUUID().replaceAll('-', '')}`;
const runtimeRole = `ai_settings_http_api_${randomUUID().replaceAll('-', '')}`;
const ownerId = randomUUID();
const origin = 'http://127.0.0.1:3000';

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
    'AI settings HTTP owner',
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
  return `/v1/channels/${channelId}/ai-moderation-settings`;
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

async function fixture() {
  const channelId = randomUUID();
  await admin.query('INSERT INTO channels(id, display_name) VALUES ($1, $2)', [
    channelId,
    'AI settings HTTP channel',
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
    'AI settings HTTP viewer',
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

async function save(f, expected_revision, value = configuration(), options = {}) {
  return request(f.url, {
    method: 'POST',
    body: { expected_revision, configuration: value },
    ...options,
  });
}

function configuration(enabled = false) {
  return {
    schema_version: 1,
    automatic_actions_enabled: enabled,
    model: {
      model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
      model_revision: '0e011be8ba6aca297059e7ab1a07d4f11054e653',
      model_variant: 'INT8',
      adapter_version: 'laskar-shadow-1',
    },
    score_metric: 'EXPECTED_SEVERITY',
    delete: { enabled: true, threshold: 0.6 },
    timeout: { enabled: true, threshold: 0.8, duration_seconds: 30 },
    ban: { enabled: false, threshold: 0.95 },
  };
}

test('owners read absence and save explicit model identity and threshold settings', async () => {
  const f = await fixture();
  const initial = await request(f.url);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.deepEqual(aiModerationSettingsResponse.parse(await initial.json()), { settings: null });
  const input = configuration();
  const response = await save(f, 0, input);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const record = aiModerationSettingsResponse.parse(await response.json()).settings;
  assert.equal(record.channel_id, f.channelId);
  assert.equal(record.created_by, ownerId);
  assert.equal(record.revision, 1);
  assert.deepEqual(record.configuration, input);
  const current = await request(endpoint(f.channelId.toUpperCase()));
  assert.equal(current.status, 200);
  assert.deepEqual(aiModerationSettingsResponse.parse(await current.json()).settings, record);
});

test('changing settings appends a revision and preserves previously saved configuration', async () => {
  const f = await fixture();
  const first = aiModerationSettingsResponse.parse(await (await save(f, 0)).json()).settings;
  const updated = configuration(true);
  updated.timeout.duration_seconds = 60;
  updated.ban.enabled = true;
  const secondResponse = await save(f, 1, updated);
  assert.equal(secondResponse.status, 200);
  const second = aiModerationSettingsResponse.parse(await secondResponse.json()).settings;
  assert.equal(second.revision, 2);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.configuration, updated);
  const disabled = await save(f, 2, { ...updated, automatic_actions_enabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(aiModerationSettingsResponse.parse(await disabled.json()).settings.revision, 3);
  const history = await admin.query(
    'SELECT configuration FROM channel_ai_moderation_settings WHERE id = $1',
    [first.id],
  );
  assert.deepEqual(history.rows[0].configuration, first.configuration);
});

test('moderators can read settings but only channel owners can save', async () => {
  const f = await fixture();
  assert.equal((await save(f, 0)).status, 200);
  const actor = await viewer(f.channelId, 'MODERATOR');
  const read = await request(f.url, { cookie: actor.cookie });
  assert.equal(read.status, 200);
  assert.equal(aiModerationSettingsResponse.parse(await read.json()).settings.revision, 1);
  const denied = await save(f, 1, configuration(true), { cookie: actor.cookie });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'AI_SETTINGS_WRITE_FORBIDDEN');
  assert.equal((await (await request(f.url)).json()).settings.revision, 1);
});

test('operators, outsiders, and owners of other channels cannot access AI settings', async () => {
  const f = await fixture();
  const other = await fixture();
  assert.equal((await save(f, 0, configuration(true))).status, 200);
  for (const actor of [
    await viewer(f.channelId, 'OPERATOR'),
    await viewer(f.channelId),
    await viewer(other.channelId, 'OWNER'),
  ]) {
    for (const response of [
      await request(f.url, { cookie: actor.cookie }),
      await save(f, 1, configuration(), { cookie: actor.cookie }),
    ]) {
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.error.code, 'CHANNEL_FORBIDDEN');
      assert.equal(JSON.stringify(body).includes('configuration'), false);
    }
  }
  assert.equal((await (await request(other.url)).json()).settings, null);
});

test('missing, expired, and revoked sessions cannot read or mutate AI settings', async () => {
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
    for (const response of [
      await request(f.url, { cookie }),
      await save(f, 0, configuration(), { cookie }),
    ]) {
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
    }
  }
  assert.equal((await (await request(f.url)).json()).settings, null);
});

test('invalid channel IDs and untrusted mutation origins cannot save settings', async () => {
  const f = await fixture();
  for (const url of [endpoint('invalid'), endpoint("' OR 1=1 --")]) {
    assert.equal((await request(url)).status, 422);
    assert.equal(
      (
        await request(url, {
          method: 'POST',
          body: { expected_revision: 0, configuration: configuration() },
        })
      ).status,
      422,
    );
  }
  for (const Origin of ['', 'https://untrusted.invalid']) {
    const denied = await save(f, 0, configuration(), { headers: { Origin } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'ORIGIN_FORBIDDEN');
  }
  assert.equal((await request(endpoint(randomUUID()))).status, 403);
  assert.equal((await (await request(f.url)).json()).settings, null);
});

test('invalid thresholds, model identity, duration, and metadata injection never persist', async () => {
  const f = await fixture();
  const valid = { expected_revision: 0, configuration: configuration() };
  for (const body of [
    {},
    { ...valid, expected_revision: '0' },
    { ...valid, expected_revision: -1 },
    { ...valid, created_by: randomUUID() },
    { ...valid, channel_id: randomUUID() },
    ...[
      { ...configuration(), automatic_actions_enabled: 'false' },
      { ...configuration(), score_metric: 'PROBABILITY' },
      { ...configuration(), model: { ...configuration().model, model_revision: 'main' } },
      { ...configuration(), model: { ...configuration().model, model_variant: 'FP32' } },
      { ...configuration(), delete: { enabled: true, threshold: '0.6' } },
      { ...configuration(), delete: { enabled: true, threshold: -0.1 } },
      { ...configuration(), delete: { enabled: true, threshold: 0.8 } },
      { ...configuration(), timeout: { enabled: true, threshold: 0.95, duration_seconds: 30 } },
      { ...configuration(), timeout: { enabled: true, threshold: 0.8 } },
      { ...configuration(), timeout: { ...configuration().timeout, duration_seconds: '30' } },
      { ...configuration(), timeout: { ...configuration().timeout, duration_seconds: 0 } },
      { ...configuration(), timeout: { ...configuration().timeout, duration_seconds: 1.5 } },
      { ...configuration(), ban: { enabled: true, threshold: 1.01 } },
      { ...configuration(), ban: { ...configuration().ban, duration_seconds: 30 } },
      {
        ...configuration(),
        timeout: { ...configuration().timeout, author_channel_id: 'injected-author' },
      },
      { ...configuration(), external_message_id: 'injected-message' },
    ].map((value) => ({ ...valid, configuration: value })),
  ]) {
    const response = await request(f.url, { method: 'POST', body });
    assert.equal(response.status, 422, await response.clone().text());
    const error = (await response.json()).error;
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.message, 'Provide valid AI moderation settings.');
    assert.ok(error.field_errors.length > 0);
    assert.ok(error.trace_id);
    assert.equal(JSON.stringify(error).includes('injected-author'), false);
    assert.equal(JSON.stringify(error).includes('injected-message'), false);
  }
  const unordered = await save(f, 0, {
    ...configuration(),
    timeout: { ...configuration().timeout, threshold: 0.6 },
  });
  assert.deepEqual((await unordered.json()).error.field_errors, [
    { field: 'configuration.timeout.threshold', code: 'custom' },
  ]);
  assert.equal((await (await request(f.url)).json()).settings, null);
});

test('concurrent and stale updates return safe conflicts and retain only the winning revision', async () => {
  const f = await fixture();
  const responses = await Promise.all([save(f, 0), save(f, 0, configuration(true))]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winner = aiModerationSettingsResponse.parse(
    await responses.find((response) => response.status === 200).json(),
  ).settings;
  const conflict = await responses.find((response) => response.status === 409).json();
  assert.equal(conflict.error.code, 'AI_SETTINGS_REVISION_CONFLICT');
  assert.equal(conflict.error.message, 'AI moderation settings changed. Reload before saving.');
  assert.ok(conflict.error.trace_id);
  assert.deepEqual(conflict.error.field_errors, []);
  assert.equal(JSON.stringify(conflict).includes('configuration'), false);
  assert.equal((await save(f, 0)).status, 409);
  assert.deepEqual(
    aiModerationSettingsResponse.parse(await (await request(f.url)).json()).settings,
    winner,
  );
  assert.equal((await save(f, 1)).status, 200);
});

test('membership changes apply before validation or revision conflict checks', async () => {
  const f = await fixture();
  const actor = await viewer(f.channelId, 'OWNER');
  assert.equal((await save(f, 0, configuration(), { cookie: actor.cookie })).status, 200);
  await admin.query(
    "UPDATE channel_memberships SET role = 'MODERATOR' WHERE channel_id = $1 AND account_id = $2",
    [f.channelId, actor.accountId],
  );
  assert.equal((await request(f.url, { cookie: actor.cookie })).status, 200);
  const denied = await request(f.url, { cookie: actor.cookie, method: 'POST', body: {} });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'AI_SETTINGS_WRITE_FORBIDDEN');
  const stale = await save(f, 0, configuration(), { cookie: actor.cookie });
  assert.equal(stale.status, 403);
  assert.equal((await stale.json()).error.code, 'AI_SETTINGS_WRITE_FORBIDDEN');
  await admin.query('DELETE FROM channel_memberships WHERE channel_id = $1 AND account_id = $2', [
    f.channelId,
    actor.accountId,
  ]);
  assert.equal((await request(f.url, { cookie: actor.cookie })).status, 403);
  assert.equal((await save(f, 1, configuration(), { cookie: actor.cookie })).status, 403);
  assert.equal((await (await request(f.url)).json()).settings.revision, 1);
});

test('oversized payloads return a safe error without creating a settings revision', async () => {
  const f = await fixture();
  const response = await save(f, 0, {
    ...configuration(),
    model: { ...configuration().model, model_id: 'x'.repeat(17000) },
  });
  assert.equal(response.status, 413);
  const error = (await response.json()).error;
  assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
  assert.ok(error.trace_id);
  assert.equal(JSON.stringify(error).includes('xxxxx'), false);
  assert.equal((await (await request(f.url)).json()).settings, null);
});

test('malformed JSON returns a safe parser error without storing settings', async () => {
  const f = await fixture();
  const response = await fetch(base + f.url, {
    method: 'POST',
    headers: { Cookie: ownerCookie, Origin: origin, 'Content-Type': 'application/json' },
    body: '{"private-debug-value":',
  });
  assert.equal(response.status, 400);
  const error = (await response.json()).error;
  assert.equal(error.code, 'BAD_REQUEST');
  assert.ok(error.trace_id);
  assert.equal(JSON.stringify(error).includes('private-debug-value'), false);
  assert.equal((await (await request(f.url)).json()).settings, null);
});
