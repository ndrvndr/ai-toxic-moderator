const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { ActorResolver } = source('apps/worker/src/ingestion/actor-resolver.ts');

function resolved(letter = 'a') {
  return {
    status: 'RESOLVED',
    channelId: `UC${letter.repeat(22)}`,
  };
}

test('successful identity expires after five minutes without sliding on reads', async () => {
  let now = 0;
  let calls = 0;

  const resolver = new ActorResolver(
    {
      async resolve() {
        calls += 1;
        return resolved();
      },
    },
    () => now,
  );

  assert.deepEqual(await resolver.resolve('token-a'), resolved());

  now = 299_999;
  assert.deepEqual(await resolver.resolve('token-a'), resolved());
  assert.equal(calls, 1);

  now = 300_000;
  await resolver.resolve('token-a');
  assert.equal(calls, 2);
});

test('failed identity lookup waits one minute before retrying', async () => {
  let now = 0;
  let calls = 0;

  const failure = {
    status: 'UNRESOLVED',
    code: 'HTTP_ERROR',
    httpStatus: 403,
  };

  const resolver = new ActorResolver(
    {
      async resolve() {
        calls += 1;
        return calls === 1 ? failure : resolved();
      },
    },
    () => now,
  );

  assert.deepEqual(await resolver.resolve('token-a'), failure);

  now = 59_999;
  assert.deepEqual(await resolver.resolve('token-a'), failure);
  assert.equal(calls, 1);

  now = 60_000;
  assert.deepEqual(await resolver.resolve('token-a'), resolved());
  assert.equal(calls, 2);
});

test('different tokens never reuse each other’s identity', async () => {
  const calls = [];

  const resolver = new ActorResolver({
    async resolve(token) {
      calls.push(token);
      return resolved(token === 'token-a' ? 'a' : 'b');
    },
  });

  assert.deepEqual(await resolver.resolve('token-a'), resolved('a'));
  assert.deepEqual(await resolver.resolve('token-b'), resolved('b'));
  assert.deepEqual(await resolver.resolve('token-a'), resolved('a'));

  assert.deepEqual(calls, ['token-a', 'token-b']);
});

test('cancellation cannot return a cached identity', async () => {
  let calls = 0;

  const resolver = new ActorResolver({
    async resolve() {
      calls += 1;
      return resolved();
    },
  });

  await resolver.resolve('token-a');

  const controller = new AbortController();
  controller.abort();

  const result = await resolver.resolve('token-a', controller.signal);

  assert.equal(result.code, 'REQUEST_CANCELLED');
  assert.equal(calls, 1);
});

test('cancellation during lookup does not populate the cache', async () => {
  let calls = 0;
  const controller = new AbortController();

  const resolver = new ActorResolver({
    async resolve(_token, signal) {
      calls += 1;

      if (calls === 1) {
        assert.equal(signal, controller.signal);
        controller.abort();
      }

      return resolved();
    },
  });

  const first = await resolver.resolve('token-a', controller.signal);

  assert.equal(first.code, 'REQUEST_CANCELLED');
  assert.deepEqual(await resolver.resolve('token-a'), resolved());
  assert.equal(calls, 2);
});

test('adapter cancellation is not cached', async () => {
  let calls = 0;

  const resolver = new ActorResolver({
    async resolve() {
      calls += 1;

      return calls === 1
        ? {
            status: 'UNRESOLVED',
            code: 'REQUEST_CANCELLED',
            httpStatus: null,
          }
        : resolved();
    },
  });

  assert.equal((await resolver.resolve('token-a')).code, 'REQUEST_CANCELLED');
  assert.deepEqual(await resolver.resolve('token-a'), resolved());
  assert.equal(calls, 2);
});

test('transport exceptions are safe and receive a retry cooldown', async () => {
  let calls = 0;

  const resolver = new ActorResolver({
    async resolve() {
      calls += 1;
      throw new Error('Private transport details');
    },
  });

  const expected = {
    status: 'UNRESOLVED',
    code: 'TRANSPORT_ERROR',
    httpStatus: null,
  };

  assert.deepEqual(await resolver.resolve('token-a'), expected);
  assert.deepEqual(await resolver.resolve('token-a'), expected);
  assert.equal(calls, 1);
});

test('callers cannot mutate cached identity results', async () => {
  let calls = 0;
  const upstream = resolved();

  const resolver = new ActorResolver({
    async resolve() {
      calls += 1;
      return upstream;
    },
  });

  const first = await resolver.resolve('token-a');
  first.channelId = 'changed-by-caller';
  upstream.channelId = 'changed-upstream';

  assert.deepEqual(await resolver.resolve('token-a'), resolved());
  assert.equal(calls, 1);
});

test('cache capacity is bounded', async () => {
  let calls = 0;

  const resolver = new ActorResolver(
    {
      async resolve() {
        calls += 1;
        return resolved();
      },
    },
    () => 0,
  );

  for (let index = 0; index < 257; index += 1) {
    await resolver.resolve(`token-${index}`);
  }

  assert.equal(calls, 257);

  await resolver.resolve('token-256');
  assert.equal(calls, 257);

  await resolver.resolve('token-0');
  assert.equal(calls, 258);
});
