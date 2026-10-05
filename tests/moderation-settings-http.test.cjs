const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');

const { createApi } = require('../apps/api/dist/app');
const { loadConfig } = require('@moderator/config');

const schema = `settings_http_${randomUUID().replaceAll('-', '')}`;
const runtimeRole = `settings_http_api_${randomUUID().replaceAll('-', '')}`;
const ownerId = randomUUID();
const origin = 'http://127.0.0.1:3000';
let admin;
let pool;
let app;
let base;
let ownerCookie;
let schemaCreated = false;
let roleCreated = false;

const configuration = { schema_version: 1, automatic_actions_enabled: false, rules: [] };
const strongRule = {
  rule_id: 'id.harassment.direct-insult',
  rule_version: '1',
  minimum_severity: 2,
  action: 'DELETE',
};

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
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
    ownerId,
    'Settings owner',
  ]);
  await provisionRuntimeRole(admin, { role: runtimeRole, password: randomUUID(), schema });
  roleCreated = true;
  pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${runtimeRole}`,
    max: 4,
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

function request(path, { cookie = ownerCookie, method = 'GET', body, headers = {} } = {}) {
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

function path(channelId) {
  return `/v1/channels/${channelId}/moderation-settings`;
}

async function fixture() {
  const channelId = randomUUID();
  await admin.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
    channelId,
    'Settings channel',
  ]);
  await admin.query(
    "INSERT INTO channel_memberships(channel_id, account_id, role) VALUES($1, $2, 'OWNER')",
    [channelId, ownerId],
  );
  return { channelId, url: path(channelId) };
}

test('retired built-in settings and catalog routes are unavailable and cannot save revisions', async () => {
  const f = await fixture();
  for (const endpoint of [f.url, f.url + '/rules']) {
    assert.equal((await request(endpoint)).status, 404);
  }
  const response = await request(f.url, {
    method: 'POST',
    body: {
      expected_revision: 0,
      configuration: { ...configuration, automatic_actions_enabled: true, rules: [strongRule] },
    },
  });
  assert.equal(response.status, 404);
  const count = await admin.query(
    'SELECT count(*)::int AS total FROM channel_moderation_settings WHERE channel_id = $1',
    [f.channelId],
  );
  assert.equal(count.rows[0].total, 0);
});

test('removing rule routes leaves blocked words and AI settings available to the owner', async () => {
  const f = await fixture();
  assert.equal((await request('/v1/channels/' + f.channelId + '/blacklist')).status, 200);
  assert.equal(
    (await request('/v1/channels/' + f.channelId + '/ai-moderation-settings')).status,
    200,
  );
});
