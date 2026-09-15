const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { source } = require('./helpers/source.cjs');

const { GoogleService } = source('apps/api/src/auth/google.service.ts');
const { encryptToken, decryptToken, GoogleProviderError, YOUTUBE_SCOPE } = source(
  'apps/api/src/auth/google-provider.ts',
);
const { loadConfig } = source('packages/config/src/index.ts');

const accountId = '10000000-0000-4000-8000-000000000001';
const key = randomBytes(32).toString('hex');

const config = loadConfig({
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:55432/test',
  GOOGLE_AUTH_ENABLED: 'true',
  GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-only-placeholder',
  TOKEN_ENCRYPTION_KEY: key,
});

const verifiedBroadcast = Object.freeze({
  youtube_broadcast_id: 'broadcast-1',
  youtube_channel_id: 'channel-1',
  channel_title: 'Test channel',
  title: 'Test livestream',
  live_chat_id: 'chat-1',
});

function credentials(fresh = true) {
  return {
    fresh,
    access_token_ciphertext: encryptToken('stored-access', key, `${accountId}:access`),
    refresh_token_ciphertext: encryptToken('stored-refresh', key, `${accountId}:refresh`),
  };
}

function database(row) {
  const calls = [];
  let released = false;

  const client = {
    async query(sql, values) {
      calls.push({ sql, values });

      if (sql.startsWith('SELECT *,expires_at')) {
        assert.deepEqual(values, [accountId]);
        return { rows: row ? [row] : [] };
      }

      if (
        ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) ||
        sql.startsWith('SELECT pg_advisory_xact_lock') ||
        sql.startsWith('UPDATE google_credentials')
      ) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {
      released = true;
    },
  };

  return {
    pool: { connect: async () => client },
    calls,
    get released() {
      return released;
    },
  };
}

function expectHttpError(status, code) {
  return (error) => {
    assert.equal(error.getStatus(), status);
    assert.equal(error.getResponse().code, code);
    return true;
  };
}

test('broadcast listing and verification share stored access token handling', async () => {
  const db = database(credentials());
  const listing = { items: [], truncated: false };

  const service = new GoogleService(db, config, {
    async token() {
      throw new Error('A fresh token must not be refreshed');
    },
    async broadcasts(token) {
      assert.equal(token, 'stored-access');
      assert.equal(db.calls.at(-1).sql, 'COMMIT');
      assert.equal(db.released, true);
      return listing;
    },
    async verifyBroadcast(token, broadcastId) {
      assert.equal(token, 'stored-access');
      assert.equal(broadcastId, 'broadcast-1');
      assert.equal(db.calls.at(-1).sql, 'COMMIT');
      return verifiedBroadcast;
    },
  });

  assert.equal(await service.broadcasts(accountId), listing);
  assert.equal(await service.verifyBroadcast(accountId, 'broadcast-1'), verifiedBroadcast);

  const locks = db.calls.filter((call) => call.sql.startsWith('SELECT pg_advisory_xact_lock'));

  assert.equal(locks.length, 2);
  for (const lock of locks) {
    assert.deepEqual(lock.values, [`google-token:${accountId}`]);
  }
});

for (const rotated of [false, true]) {
  test(`expired token refresh ${rotated ? 'rotates' : 'preserves'} the refresh token`, async () => {
    const row = credentials(false);
    const db = database(row);

    const service = new GoogleService(db, config, {
      async token(params) {
        assert.equal(params.grant_type, 'refresh_token');
        assert.equal(params.refresh_token, 'stored-refresh');

        return {
          access_token: 'refreshed-access',
          expires_in: 3600,
          scope: YOUTUBE_SCOPE,
          ...(rotated ? { refresh_token: 'rotated-refresh' } : {}),
        };
      },
      async verifyBroadcast(token) {
        assert.equal(token, 'refreshed-access');
        assert.equal(db.calls.at(-1).sql, 'COMMIT');
        return verifiedBroadcast;
      },
    });

    assert.equal(await service.verifyBroadcast(accountId, 'broadcast-1'), verifiedBroadcast);

    const update = db.calls.find((call) => call.sql.startsWith('UPDATE google_credentials'));
    assert.ok(update);
    assert.equal(update.values[0], accountId);
    assert.equal(decryptToken(update.values[1], key, `${accountId}:access`), 'refreshed-access');
    assert.equal(
      decryptToken(update.values[2], key, `${accountId}:refresh`),
      rotated ? 'rotated-refresh' : 'stored-refresh',
    );

    if (!rotated) {
      assert.equal(update.values[2], row.refresh_token_ciphertext);
    }
  });
}

test('missing credentials require reconnection before contacting YouTube', async () => {
  const db = database(null);
  const service = new GoogleService(db, config, {
    async verifyBroadcast() {
      assert.fail('YouTube must not be called without credentials');
    },
  });

  await assert.rejects(
    service.verifyBroadcast(accountId, 'broadcast-1'),
    expectHttpError(409, 'RECONNECT_REQUIRED'),
  );

  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(db.released, true);
});

test('refresh with insufficient scope cannot persist tokens or verify a broadcast', async () => {
  const db = database(credentials(false));
  const service = new GoogleService(db, config, {
    async token() {
      return {
        access_token: 'insufficient-access',
        expires_in: 3600,
        scope: 'openid profile',
      };
    },
    async verifyBroadcast() {
      assert.fail('YouTube must not be called with insufficient scope');
    },
  });

  await assert.rejects(
    service.verifyBroadcast(accountId, 'broadcast-1'),
    expectHttpError(409, 'RECONNECT_REQUIRED'),
  );

  assert.equal(
    db.calls.some((call) => call.sql.startsWith('UPDATE google_credentials')),
    false,
  );
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
});

test('provider failures map to safe HTTP errors', async () => {
  const cases = [
    ['RECONNECT_REQUIRED', 409],
    ['GOOGLE_UNAVAILABLE', 502],
    ['YOUTUBE_FORBIDDEN', 502],
    ['INVALID_BROADCAST_ID', 422],
    ['BROADCAST_NOT_FOUND', 404],
    ['BROADCAST_NOT_OWNED', 403],
    ['BROADCAST_NOT_LIVE', 409],
    ['LIVE_CHAT_UNAVAILABLE', 409],
    ['YOUTUBE_LOOKUP_INCOMPLETE', 503],
  ];

  for (const [code, status] of cases) {
    const service = new GoogleService(database(credentials()), config, {
      async verifyBroadcast() {
        const error = new GoogleProviderError(code);
        error.message = 'sensitive-provider-detail';
        throw error;
      },
    });

    await assert.rejects(service.verifyBroadcast(accountId, 'broadcast-1'), (error) => {
      expectHttpError(status, code)(error);
      assert.equal(
        JSON.stringify(error.getResponse()).includes('sensitive-provider-detail'),
        false,
      );
      return true;
    });
  }
});

test('disabled Google authentication prevents database and provider access', async () => {
  const service = new GoogleService(
    {
      pool: {
        async connect() {
          assert.fail('The database must not be accessed');
        },
      },
    },
    { ...config, GOOGLE_AUTH_ENABLED: false },
    {
      async verifyBroadcast() {
        assert.fail('YouTube must not be called');
      },
    },
  );

  await assert.rejects(
    service.verifyBroadcast(accountId, 'broadcast-1'),
    expectHttpError(404, 'GOOGLE_AUTH_DISABLED'),
  );
});

test('an explicitly empty refresh scope requires reconnection', async () => {
  const db = database(credentials(false));

  const service = new GoogleService(db, config, {
    async token() {
      return {
        access_token: 'insufficient-access',
        expires_in: 3600,
        scope: '',
      };
    },
    async verifyBroadcast() {
      assert.fail('YouTube must not be called with an empty granted scope');
    },
  });

  await assert.rejects(
    service.verifyBroadcast(accountId, 'broadcast-1'),
    expectHttpError(409, 'RECONNECT_REQUIRED'),
  );

  assert.equal(
    db.calls.some((call) => call.sql.startsWith('UPDATE google_credentials')),
    false,
  );
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
});
