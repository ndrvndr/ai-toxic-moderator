const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { source } = require('./helpers/source.cjs');
const { encryptToken, decryptToken, GoogleProvider, GoogleProviderError, YOUTUBE_SCOPE } = source(
  'apps/api/src/auth/google-provider.ts',
);
const { GoogleService, oauthBrowserToken, oauthCookie } = source(
  'apps/api/src/auth/google.service.ts',
);
const { loadConfig } = source('packages/config/src/index.ts');
const key = randomBytes(32).toString('hex');
const env = {
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:55432/test',
  GOOGLE_AUTH_ENABLED: 'true',
  GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-only-placeholder',
  TOKEN_ENCRYPTION_KEY: key,
};

test('Google config fails closed for missing credentials, key and mismatched callback', () => {
  assert.equal(loadConfig(env).GOOGLE_AUTH_ENABLED, true);
  for (const change of [
    { GOOGLE_CLIENT_SECRET: '' },
    { TOKEN_ENCRYPTION_KEY: 'short' },
    { GOOGLE_REDIRECT_URI: 'https://attacker.invalid/callback' },
    { GOOGLE_REDIRECT_URI: 'http://localhost:3001/v1/auth/google/callback' },
  ])
    assert.throws(() => loadConfig({ ...env, ...change }));
  assert.equal(loadConfig({ DATABASE_URL: env.DATABASE_URL }).GOOGLE_AUTH_ENABLED, false);
});

test('encrypted tokens are randomized and bound to account and token purpose', () => {
  const first = encryptToken('private-token', key, 'account-a:refresh');
  assert.notEqual(first, encryptToken('private-token', key, 'account-a:refresh'));
  assert.equal(first.includes('private-token'), false);
  assert.equal(decryptToken(first, key, 'account-a:refresh'), 'private-token');
  assert.throws(() => decryptToken(first, key, 'account-b:refresh'));
  assert.throws(() => decryptToken(first, key, 'account-a:access'));
  assert.throws(() => decryptToken(first, randomBytes(32).toString('hex'), 'account-a:refresh'));
  const parts = first.split('.');
  const bytes = Buffer.from(parts[3], 'base64url');
  bytes[0] ^= 1;
  parts[3] = bytes.toString('base64url');
  assert.throws(() => decryptToken(parts.join('.'), key, 'account-a:refresh'));
});

test('OAuth cookie allows Google callback and rejects ambiguous cookies', () => {
  const token = randomBytes(32).toString('base64url');
  assert.match(oauthCookie(token), /HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.equal(oauthBrowserToken(`atm_google_oauth=${token}`), token);
  assert.equal(oauthBrowserToken(`atm_google_oauth=${token}; atm_google_oauth=${token}`), null);
  assert.equal(oauthBrowserToken('atm_google_oauth=invalid'), null);
});

test('callback missing browser binding never queries DB or exchanges a code', async () => {
  const unexpected = () => {
    throw Error('Must not be called');
  };
  const service = new GoogleService({ pool: { query: unexpected } }, loadConfig(env), {
    token: unexpected,
  });
  await assert.rejects(
    service.complete('a'.repeat(43), null, 'code', false, null),
    (error) => error.getStatus() === 400,
  );
});

test('expired or replayed callback never exchanges authorization code', async () => {
  let exchanges = 0;
  const service = new GoogleService(
    { pool: { query: async () => ({ rows: [] }) } },
    loadConfig(env),
    {
      token: async () => {
        exchanges++;
      },
    },
  );
  await assert.rejects(
    service.complete('a'.repeat(43), 'b'.repeat(43), 'code', false, null),
    (error) => error.getStatus() === 400,
  );
  assert.equal(exchanges, 0);
});

test('denied consent consumes attempt but never exchanges code', async () => {
  let consumed = 0;
  const service = new GoogleService(
    {
      pool: {
        query: async () => {
          consumed++;
          return { rows: [{}] };
        },
      },
    },
    loadConfig(env),
    {
      token: async () => {
        throw Error('Must not exchange');
      },
    },
  );
  await assert.rejects(
    service.complete('a'.repeat(43), 'b'.repeat(43), undefined, true, null),
    (error) => error.getResponse().code === 'OAUTH_DENIED',
  );
  assert.equal(consumed, 1);
});

test('authorization URL binds PKCE verifier to an encrypted single-use attempt', async () => {
  let attempt;
  const client = {
    query: async (sql, values) => {
      if (sql.startsWith('INSERT INTO google_oauth_attempts')) attempt = values;
      return { rows: [] };
    },
    release() {},
  };
  const service = new GoogleService({ pool: { connect: async () => client } }, loadConfig(env), {});
  const result = await service.start(null);
  const url = new URL(result.url);
  const { createHash } = require('node:crypto');
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('client_secret'), null);
  assert.equal(
    attempt[0],
    createHash('sha256').update(url.searchParams.get('state')).digest('hex'),
  );
  assert.equal(attempt[1], createHash('sha256').update(result.browser).digest('hex'));
  const verifier = decryptToken(attempt[2], key, `oauth:${attempt[0]}`);
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(verifier).digest('base64url'),
  );
});

test('insufficient YouTube consent cannot create an application account or session', async () => {
  const { createHash } = require('node:crypto');
  const state = 'a'.repeat(43);
  const stateHash = createHash('sha256').update(state).digest('hex');
  const service = new GoogleService(
    {
      pool: {
        query: async () => ({
          rows: [{ verifier_ciphertext: encryptToken('verifier', key, `oauth:${stateHash}`) }],
        }),
        connect: async () => {
          throw Error('Must not persist an account');
        },
      },
    },
    loadConfig(env),
    { token: async () => ({ access_token: 'token', scope: 'openid profile' }) },
  );
  await assert.rejects(
    service.complete(state, 'b'.repeat(43), 'code', false, null),
    (error) => error.getResponse().code === 'GOOGLE_SCOPE_REQUIRED',
  );
});

test('token exchange sends credentials in body and rejects malformed tokens', async () => {
  const provider = new GoogleProvider(async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init.method, 'POST');
    assert.equal(init.body.get('code_verifier'), 'verifier');
    assert.equal(init.redirect, 'error');
    return Response.json({
      access_token: 'token',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: `openid ${YOUTUBE_SCOPE}`,
    });
  });
  assert.equal(
    (await provider.token({ grant_type: 'authorization_code', code_verifier: 'verifier' }))
      .access_token,
    'token',
  );
  const broken = new GoogleProvider(async () => Response.json({ access_token: 'token' }));
  await assert.rejects(broken.token({}));
});

test('provider errors omit sensitive response bodies', async () => {
  const provider = new GoogleProvider(async () =>
    Response.json(
      { error: 'invalid_grant', error_description: 'sensitive-value' },
      { status: 400 },
    ),
  );
  await assert.rejects(
    provider.token({}),
    (error) =>
      error instanceof GoogleProviderError &&
      error.code === 'RECONNECT_REQUIRED' &&
      !error.message.includes('sensitive-value'),
  );
});

test('broadcasts use authenticated ownership filter and expose no chat token or credentials', async () => {
  const provider = new GoogleProvider(async (url, init) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('mine'), 'true');
    assert.equal(params.has('broadcastStatus'), false);
    assert.equal(init.headers.Authorization, 'Bearer private-access');
    return Response.json({
      items: [
        {
          id: 'live-id',
          snippet: { title: 'Live', channelId: 'owner', liveChatId: 'chat-id' },
          status: { lifeCycleStatus: 'live' },
        },
        {
          id: 'ended',
          snippet: { title: 'Ended', channelId: 'owner' },
          status: { lifeCycleStatus: 'complete' },
        },
      ],
    });
  });
  const data = await provider.broadcasts('private-access');
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].youtube_broadcast_id, 'live-id');
  assert.equal(data.items[0].live_chat_available, true);
  assert.equal(JSON.stringify(data).includes('private-access'), false);
});
