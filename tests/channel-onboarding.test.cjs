const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client, Pool } = require('pg');
const { createApi } = require('../apps/api/dist/app');
const {
  GoogleProvider,
  GoogleProviderError,
  YOUTUBE_SCOPE,
} = require('@moderator/provider-adapters');
const { loadConfig } = require('@moderator/config');
const { meResponse } = require('@moderator/contracts');

const schema = `onboarding_${randomUUID().replaceAll('-', '')}`;
const role = `atm_onboard_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://127.0.0.1:3000';
const youtubeId = `channel-${randomUUID()}`;
let admin, pool, app, base, cookie, accountId;
let createdSchema = false,
  createdRole = false;
let owned = [{ youtube_channel_id: youtubeId, channel_title: 'My streaming channel' }];
let channelError = null;
let subject = `subject-${randomUUID()}`;
let lookupCount = 0;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
    throw Error('Set TEST_DATABASE_URL to a local test database.');
  }
  admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  createdSchema = true;
  await admin.query(`SET search_path TO ${schema}`);
  const { migrate } = await import('../scripts/database.mjs');
  const { provisionRuntimeRole } = await import('../scripts/runtime-role.mjs');
  await migrate(admin);
  await provisionRuntimeRole(admin, { role, password: randomUUID(), schema });
  createdRole = true;
  pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${role}`,
    max: 4,
  });
  app = await createApi(
    loadConfig({
      DATABASE_URL: url,
      NODE_ENV: 'test',
      GOOGLE_AUTH_ENABLED: 'true',
      GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-placeholder',
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      DASHBOARD_ORIGIN: origin,
    }),
    pool,
  );
  const provider = app.get(GoogleProvider);
  provider.token = async () => ({
    access_token: 'test-access',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    scope: `openid ${YOUTUBE_SCOPE}`,
  });
  provider.profile = async () => ({ sub: subject, name: 'Test streamer' });
  provider.channels = async (token) => {
    assert.equal(token, 'test-access');
    lookupCount++;
    if (channelError) throw new GoogleProviderError(channelError);
    return owned;
  };
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
after(async () => {
  try {
    if (app) await app.close();
    else if (pool) await pool.end();
  } finally {
    if (admin) {
      try {
        if (createdSchema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        if (createdRole) await admin.query(`DROP ROLE ${role}`);
      } finally {
        await admin.end();
      }
    }
  }
});
async function login() {
  const start = await fetch(`${base}/v1/auth/google`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const oauthCookie = start.headers.get('set-cookie').split(';')[0];
  const callback = await fetch(`${base}/v1/auth/google/callback?state=${state}&code=test-code`, {
    redirect: 'manual',
    headers: { Cookie: oauthCookie },
  });
  assert.equal(callback.headers.get('location'), `${origin}/live`);
  cookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith('atm_dev_session='))
    .split(';')[0];
  return await (await fetch(`${base}/v1/me`, { headers: { Cookie: cookie } })).json();
}
function sync(body = {}, headers = {}) {
  return fetch(`${base}/v1/youtube/channels/sync`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('first Google login prepares named owner settings without a stream or run', async () => {
  const me = meResponse.parse(await login());
  accountId = me.account.id;
  assert.equal(me.memberships.length, 1);
  assert.equal(me.memberships[0].role, 'OWNER');
  assert.equal(me.memberships[0].channel_name, 'My streaming channel');
  const channelId = me.memberships[0].channel_id;
  for (const suffix of ['blacklist', 'ai-moderation-settings']) {
    const response = await fetch(`${base}/v1/channels/${channelId}/${suffix}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200, await response.clone().text());
  }
  const save = await fetch(`${base}/v1/channels/${channelId}/blacklist`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expected_revision: 0,
      configuration: {
        schema_version: 1,
        enabled: true,
        rules: [
          {
            id: randomUUID(),
            enabled: true,
            match_type: 'WORD',
            pattern: 'blockedword',
            action: 'DELETE',
          },
        ],
      },
    }),
  });
  assert.equal(save.status, 200, await save.clone().text());
  assert.equal((await admin.query('SELECT 1 FROM stream_sessions')).rowCount, 0);
  assert.equal((await admin.query('SELECT 1 FROM monitoring_runs')).rowCount, 0);
  const before = lookupCount;
  await fetch(`${base}/v1/me`, { headers: { Cookie: cookie } });
  assert.equal(lookupCount, before, 'Session reads must never poll YouTube');
});

test('sync is idempotent under concurrency, updates names and preserves other memberships', async () => {
  const other = randomUUID();
  await admin.query('INSERT INTO channels(id, display_name) VALUES($1,$2)', [
    other,
    'Other channel',
  ]);
  await admin.query(
    "INSERT INTO channel_memberships(channel_id,account_id,role) VALUES($1,$2,'MODERATOR')",
    [other, accountId],
  );
  owned = [{ youtube_channel_id: youtubeId, channel_title: 'Renamed streaming channel' }];
  const responses = await Promise.all([sync(), sync(), sync()]);
  for (const response of responses) {
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { channel_count: 1 });
  }
  const mapping = await admin.query(
    'SELECT channel_id FROM youtube_channels WHERE youtube_channel_id=$1',
    [youtubeId],
  );
  assert.equal(mapping.rowCount, 1);
  const me = await (await fetch(`${base}/v1/me`, { headers: { Cookie: cookie } })).json();
  assert.equal(me.memberships.find((m) => m.channel_id === other).role, 'MODERATOR');
  assert.equal(
    me.memberships.find((m) => m.channel_id === mapping.rows[0].channel_id).channel_name,
    'Renamed streaming channel',
  );
  await assert.rejects(pool.query('UPDATE channels SET id=id'), { code: '42501' });
});

test('sync rejects missing sessions, foreign origins and client-selected ownership before lookup', async () => {
  const before = lookupCount;
  assert.equal((await sync({}, { Cookie: '' })).status, 401);
  assert.equal((await sync({}, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal(
    (await sync({ account_id: randomUUID(), channel_id: randomUUID(), role: 'OWNER' })).status,
    422,
  );
  assert.equal(lookupCount, before);
});

test('monitoring and simultaneous channel setup reuse the prepared channel and saved settings', async () => {
  const existing = (
    await admin.query('SELECT channel_id FROM youtube_channels WHERE youtube_channel_id=$1', [
      youtubeId,
    ])
  ).rows[0].channel_id;
  const broadcastId = `broadcast-${randomUUID()}`;
  app.get(GoogleProvider).verifyBroadcast = async (token, id) => {
    assert.equal(token, 'test-access');
    assert.equal(id, broadcastId);
    return {
      youtube_broadcast_id: id,
      youtube_channel_id: youtubeId,
      channel_title: 'Renamed streaming channel',
      title: 'My first stream',
      live_chat_id: `chat-${randomUUID()}`,
    };
  };
  const [start, setup] = await Promise.all([
    fetch(`${base}/v1/monitoring/start`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ youtube_broadcast_id: broadcastId }),
    }),
    sync(),
  ]);
  assert.equal(start.status, 200, await start.clone().text());
  assert.equal(setup.status, 201);
  assert.equal((await start.json()).run.channel_id, existing);
  const blacklist = await (
    await fetch(`${base}/v1/channels/${existing}/blacklist`, { headers: { Cookie: cookie } })
  ).json();
  assert.equal(blacklist.blacklist.configuration.rules[0].pattern, 'blockedword');
  assert.equal(blacklist.blacklist.revision, 1);
});

test('provider failure keeps login available, grants no channel and supports an explicit retry', async () => {
  subject = `new-subject-${randomUUID()}`;
  channelError = 'YOUTUBE_FORBIDDEN';
  const me = await login();
  assert.deepEqual(me.memberships, []);
  const unrelated = (
    await admin.query('SELECT channel_id FROM youtube_channels WHERE youtube_channel_id=$1', [
      youtubeId,
    ])
  ).rows[0].channel_id;
  assert.equal(
    (await fetch(`${base}/v1/channels/${unrelated}/blacklist`, { headers: { Cookie: cookie } }))
      .status,
    403,
  );
  const failed = await sync();
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error.code, 'YOUTUBE_FORBIDDEN');
  channelError = null;
  owned = [];
  assert.deepEqual(await (await sync()).json(), { channel_count: 0 });
  owned = [{ youtube_channel_id: `new-channel-${randomUUID()}`, channel_title: 'New streamer' }];
  assert.equal((await sync()).status, 201);
  const ready = await (await fetch(`${base}/v1/me`, { headers: { Cookie: cookie } })).json();
  assert.equal(ready.memberships[0].role, 'OWNER');
  assert.equal(ready.memberships[0].channel_name, 'New streamer');
});
