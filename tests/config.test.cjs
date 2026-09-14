const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('@moderator/config');

const env = { DATABASE_URL: 'postgresql://demo:demo@127.0.0.1:55432/demo' };

test('development config is local and fail-closed', () => {
  assert.equal(loadConfig(env).WORKER_ENABLED, false);
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }));
  assert.throws(() =>
    loadConfig({ ...env, DATABASE_URL: 'postgresql://demo:demo@external.invalid/demo' }),
  );
  assert.throws(() => loadConfig({ ...env, API_PORT: 'NaN' }));
  assert.throws(() => loadConfig({ ...env, WORKER_ENABLED: 'yes' }));
});

test('invalid configuration does not leak the connection secret', () => {
  try {
    loadConfig({ DATABASE_URL: 'not-a-url-secret' });
    assert.fail('expected rejection');
  } catch (e) {
    assert.equal(e.message.includes('not-a-url-secret'), false);
  }
});

test('development authentication requires opt-in and an exact local origin', () => {
  assert.equal(loadConfig(env).DEV_AUTH_ENABLED, false);
  assert.equal(loadConfig({ ...env, DEV_AUTH_ENABLED: 'true' }).DEV_AUTH_ENABLED, true);
  for (const DASHBOARD_ORIGIN of [
    'https://example.com',
    'http://127.0.0.1:3000/',
    'http://user:pass@localhost:3000',
    'null',
  ])
    assert.throws(() => loadConfig({ ...env, DASHBOARD_ORIGIN }));
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production', DEV_AUTH_ENABLED: 'true' }));
  assert.throws(() => loadConfig({ ...env, SESSION_TTL_SECONDS: '0' }));
  assert.throws(() => loadConfig({ ...env, DEV_ACCOUNT_ID: 'forged' }));
});
