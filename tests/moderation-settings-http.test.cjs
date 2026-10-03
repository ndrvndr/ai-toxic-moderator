const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { Client, Pool } = require('pg');

const { createApi } = require('../apps/api/dist/app');
const { loadConfig } = require('@moderator/config');
const {
  moderationSettingsResponse,
  moderationRuleCatalogResponse,
} = require('@moderator/contracts');
const { source } = require('./helpers/source.cjs');

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

async function viewer(channelId, role) {
  const accountId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await admin.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    accountId,
    'Settings viewer',
  ]);
  if (role) {
    await admin.query(
      'INSERT INTO channel_memberships(channel_id, account_id, role) VALUES($1, $2, $3)',
      [channelId, accountId, role],
    );
  }
  await admin.query(
    `INSERT INTO dashboard_sessions(id, account_id, token_hash, expires_at)
     VALUES($1, $2, $3, clock_timestamp() + interval '1 hour')`,
    [randomUUID(), accountId, hash],
  );
  return { accountId, hash, cookie: `atm_dev_session=${token}` };
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

test('owners can read absent settings, save revisions, and read shared supported rules', async () => {
  const f = await fixture();
  const initial = await request(f.url);
  assert.equal(initial.status, 200);
  assert.deepEqual(moderationSettingsResponse.parse(await initial.json()), { settings: null });
  for (const [revision, action] of [
    [0, 'DELETE'],
    [1, 'TIMEOUT'],
    [2, 'BAN'],
  ]) {
    const rule = {
      ...strongRule,
      action,
      ...(action === 'TIMEOUT' ? { duration_seconds: 30 } : {}),
    };
    const response = await request(f.url, {
      method: 'POST',
      body: { expected_revision: revision, configuration: { ...configuration, rules: [rule] } },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = moderationSettingsResponse.parse(await response.json()).settings;
    assert.equal(saved.revision, revision + 1);
    assert.equal(saved.channel_id, f.channelId);
    assert.equal(saved.created_by, ownerId);
  }
  const current = await request(f.url);
  assert.equal(moderationSettingsResponse.parse(await current.json()).settings.revision, 3);
  const catalog = await request(f.url + '/rules');
  assert.equal(catalog.status, 200);
  const items = moderationRuleCatalogResponse.parse(await catalog.json()).items;
  assert.equal(items.length, 3);
  assert.deepEqual(items.find((rule) => rule.rule_id === strongRule.rule_id).supported_actions, [
    'DELETE',
    'TIMEOUT',
    'BAN',
  ]);
  assert.ok(
    items
      .filter((rule) => rule.strength === 'AMBIGUOUS')
      .every((rule) => rule.supported_actions.length === 0),
  );
});

test('moderators can read settings and rules but cannot save changes', async () => {
  const f = await fixture();
  const moderator = await viewer(f.channelId, 'MODERATOR');
  for (const url of [f.url, f.url + '/rules']) {
    assert.equal((await request(url, { cookie: moderator.cookie })).status, 200);
  }
  const denied = await request(f.url, {
    cookie: moderator.cookie,
    method: 'POST',
    body: { expected_revision: 0, configuration },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'SETTINGS_WRITE_FORBIDDEN');
  assert.equal((await (await request(f.url)).json()).settings, null);
});

test('operators, outsiders, and owners of other channels cannot read or write settings', async () => {
  const f = await fixture();
  const other = await fixture();
  const viewers = [
    await viewer(f.channelId, 'OPERATOR'),
    await viewer(f.channelId),
    await viewer(other.channelId, 'OWNER'),
  ];
  for (const actor of viewers) {
    for (const url of [f.url, f.url + '/rules']) {
      assert.equal((await request(url, { cookie: actor.cookie })).status, 403);
    }
    assert.equal(
      (
        await request(f.url, {
          cookie: actor.cookie,
          method: 'POST',
          body: { expected_revision: 0, configuration },
        })
      ).status,
      403,
    );
  }
});

test('requests require a current session, valid channel ID, and trusted mutation origin', async () => {
  const f = await fixture();
  for (const url of [f.url, f.url + '/rules']) {
    assert.equal((await request(url, { cookie: '' })).status, 401);
  }
  assert.equal(
    (
      await request(f.url, {
        cookie: '',
        method: 'POST',
        body: { expected_revision: 0, configuration },
      })
    ).status,
    401,
  );
  assert.equal((await request(path('invalid'))).status, 422);
  assert.equal(
    (
      await request(f.url, {
        method: 'POST',
        headers: { Origin: 'https://untrusted.invalid' },
        body: { expected_revision: 0, configuration },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(f.url, {
        method: 'POST',
        headers: { Origin: '' },
        body: { expected_revision: 0, configuration },
      })
    ).status,
    403,
  );
  const expired = await viewer(f.channelId, 'OWNER');
  await admin.query(
    `UPDATE dashboard_sessions
    SET created_at = clock_timestamp() - interval '2 hours',
        expires_at = clock_timestamp() - interval '1 hour' WHERE token_hash = $1`,
    [expired.hash],
  );
  assert.equal((await request(f.url, { cookie: expired.cookie })).status, 401);
});

test('unsupported rules, versions, ambiguous actions, and actor injection are rejected', async () => {
  const f = await fixture();
  for (const [rule, code] of [
    [{ ...strongRule, rule_id: 'unknown.rule' }, 'UNSUPPORTED_RULE'],
    [{ ...strongRule, rule_version: '999' }, 'UNSUPPORTED_RULE'],
    [{ ...strongRule, rule_id: 'development.ban-test-fixture' }, 'UNSUPPORTED_RULE'],
    [{ ...strongRule, rule_id: 'id.gambling.promotion' }, 'UNSUPPORTED_RULE_ACTION'],
    [
      { ...strongRule, rule_id: 'generic.suspicious-link', action: 'BAN' },
      'UNSUPPORTED_RULE_ACTION',
    ],
  ]) {
    const response = await request(f.url, {
      method: 'POST',
      body: {
        expected_revision: 0,
        configuration: { ...configuration, rules: [rule] },
      },
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, code);
  }
  for (const body of [
    { expected_revision: 0, configuration, created_by: randomUUID() },
    { expected_revision: 0, configuration, channel_id: randomUUID() },
    { expected_revision: '0', configuration },
    {
      expected_revision: 0,
      configuration: { ...configuration, rules: [{ ...strongRule, action: 'TIMEOUT' }] },
    },
    { expected_revision: 0, configuration: { ...configuration, rules: [strongRule, strongRule] } },
  ]) {
    assert.equal((await request(f.url, { method: 'POST', body })).status, 422);
  }
  assert.equal((await (await request(f.url)).json()).settings, null);
});

test('competing saves return one success and one safe revision conflict', async () => {
  const f = await fixture();
  const responses = await Promise.all(
    [0, 1].map(() =>
      request(f.url, {
        method: 'POST',
        body: { expected_revision: 0, configuration },
      }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const conflict = await responses.find((response) => response.status === 409).json();
  assert.equal(conflict.error.code, 'SETTINGS_REVISION_CONFLICT');
  assert.equal(conflict.error.message, 'Settings changed. Reload before saving.');
  assert.ok(conflict.error.trace_id);
  assert.equal((await (await request(f.url)).json()).settings.revision, 1);
});

test('membership changes and session revocation apply to subsequent settings requests', async () => {
  const f = await fixture();
  const actor = await viewer(f.channelId, 'OWNER');
  assert.equal((await request(f.url, { cookie: actor.cookie })).status, 200);
  await admin.query(
    "UPDATE channel_memberships SET role = 'MODERATOR' WHERE channel_id = $1 AND account_id = $2",
    [f.channelId, actor.accountId],
  );
  assert.equal(
    (
      await request(f.url, {
        cookie: actor.cookie,
        method: 'POST',
        body: { expected_revision: 0, configuration },
      })
    ).status,
    403,
  );
  await admin.query('DELETE FROM channel_memberships WHERE channel_id = $1 AND account_id = $2', [
    f.channelId,
    actor.accountId,
  ]);
  assert.equal((await request(f.url, { cookie: actor.cookie })).status, 403);
  await admin.query('DELETE FROM dashboard_sessions WHERE token_hash = $1', [actor.hash]);
  assert.equal((await request(f.url, { cookie: actor.cookie })).status, 401);
});

test('shared catalog matches source worker metadata and retains existing detection patterns', () => {
  const { DEFAULT_RULES } = source('apps/worker/src/ingestion/default-rules.ts');
  const { BUILTIN_MODERATION_RULE_CATALOG } = source(
    'packages/contracts/src/moderation-rule-catalog.ts',
  );
  for (const entry of BUILTIN_MODERATION_RULE_CATALOG) {
    const implementation = DEFAULT_RULES.find((rule) => rule.id === entry.rule_id);
    assert.ok(implementation);
    assert.equal(implementation.version, entry.rule_version);
    assert.equal(implementation.category, entry.category);
    assert.equal(implementation.severity, entry.severity);
    assert.equal(implementation.strength, entry.strength);
  }
  assert.equal(DEFAULT_RULES.length, BUILTIN_MODERATION_RULE_CATALOG.length);
  for (const [id, text] of [
    ['id.harassment.direct-insult', 'kamu bodoh'],
    ['id.gambling.promotion', 'judi'],
    ['generic.suspicious-link', 'https://example.invalid'],
  ]) {
    const rule = DEFAULT_RULES.find((entry) => entry.id === id);
    assert.ok(new RegExp(rule.pattern.source, rule.pattern.flags).test(text));
  }
});
