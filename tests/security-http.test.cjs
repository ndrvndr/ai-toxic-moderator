const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { createApi } = source('apps/api/src/app.ts');
const { loadConfig } = source('packages/config/src/index.ts');
const nextConfig = source('apps/dashboard/next.config.ts').default;
let app, base;
before(async () => {
  app = await createApi(
    loadConfig({
      DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:15432/fixture',
      NODE_ENV: 'test',
    }),
    {
      query: async () => {
        throw new Error('SELECT secret FROM private_table; private-password');
      },
      end: async () => {},
    },
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
after(async () => {
  if (app) await app.close();
});
const expected = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
test('API success and failure responses carry defensive headers without technology disclosure', async () => {
  for (const route of ['/health/live', '/health/ready', '/v1/me', '/missing']) {
    const response = await fetch(base + route);
    for (const [key, value] of Object.entries(expected))
      assert.equal(response.headers.get(key), value);
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.equal(/private-password|private_table|SELECT secret|stack/i.test(body), false);
  }
});
test('malformed and oversized JSON are rejected with safe errors before reaching database operations', async () => {
  for (const [body, status] of [
    ['{broken-json', 400],
    [JSON.stringify({ value: 'x'.repeat(17000) }), 413],
  ]) {
    const response = await fetch(base + '/v1/auth/dev-session', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const text = await response.text();
    assert.equal(text.includes('broken-json'), false);
    assert.equal(text.includes('private-password'), false);
  }
});
test('dashboard headers protect every route without applying production HTTPS assumptions to loopback', async () => {
  const rules = await nextConfig.headers();
  assert.equal(rules[0].source, '/:path*');
  const headers = Object.fromEntries(
    rules[0].headers.map(({ key, value }) => [key.toLowerCase(), value]),
  );
  for (const [key, value] of Object.entries(expected)) assert.equal(headers[key], value);
  assert.equal(nextConfig.poweredByHeader, false);
});
