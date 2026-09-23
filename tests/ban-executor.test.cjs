const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { BanExecutor } = source('apps/worker/src/ingestion/ban-executor.ts');

function fixture() {
  const calls = [];
  const execution = {
    id: 'execution',
    plan_id: 'original-plan',
    channel_id: 'channel',
    session_id: 'session',
    live_chat_id: 'persisted-chat',
    author_channel_id: 'persisted-author',
    action: 'TIMEOUT',
    duration_seconds: '300',
  };
  const claim = {
    execution,
    attempt_id: 'attempt',
    owner_id: 'owner',
    deadline_at: new Date(Date.now() + 30000).toISOString(),
  };
  const input = {
    planId: 'new-plan',
    channelId: 'channel',
    sessionId: 'session',
    ownerId: 'owner',
  };
  const store = {
    async ensure(...args) {
      calls.push(['ensure', ...args]);
      return execution;
    },
    async claim(...args) {
      calls.push(['claim', ...args]);
      return claim;
    },
    async complete(...args) {
      calls.push(['complete', ...args]);
      return true;
    },
  };
  const eligibility = {
    async resolve(value) {
      calls.push(['resolve', value]);
      return { accountId: 'persisted-account' };
    },
  };
  const tokens = {
    async accessToken(id) {
      calls.push(['token', id]);
      return 'test-token';
    },
  };
  const adapter = {
    async banUser(value) {
      calls.push(['ban', value]);
      return { status: 'SUCCEEDED', http_status: 200, ban_id: 'provider-ban' };
    },
  };
  const actors = {
    async resolve(accessToken, signal) {
      calls.push(['actor', accessToken, signal]);

      return {
        status: 'RESOLVED',
        channelId: `UC${'a'.repeat(22)}`,
      };
    },
  };
  return {
    calls,
    execution,
    claim,
    input,
    store,
    eligibility,
    tokens,
    adapter,
    actors,
    executor: new BanExecutor(store, eligibility, tokens, adapter, actors),
  };
}

test('checks original provenance, commits claim, sends persisted target, and records result', async () => {
  const f = fixture();
  const result = await f.executor.execute(f.input);
  assert.equal(result.status, 'RECORDED');
  assert.equal(result.result.status, 'SUCCEEDED');
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['ensure', 'resolve', 'token', 'actor', 'resolve', 'claim', 'resolve', 'ban', 'complete'],
  );
  assert.equal(f.calls.find(([name]) => name === 'token')[1], 'persisted-account');
  for (const [, value] of f.calls.filter(([name]) => name === 'resolve')) {
    assert.equal(value.plan_id, 'original-plan');
  }
  assert.equal(f.calls.find(([name]) => name === 'ban')[1].authorChannelId, 'persisted-author');
});

test('ineligible executions and failed credentials never claim or dispatch', async () => {
  for (const reason of ['INELIGIBLE', 'CREDENTIALS_UNAVAILABLE']) {
    const f = fixture();
    if (reason === 'INELIGIBLE') f.eligibility.resolve = async () => null;
    else
      f.tokens.accessToken = async () => {
        throw Error('private provider details');
      };
    assert.deepEqual(await f.executor.execute(f.input), { status: 'SKIPPED', reason });
    assert.ok(!f.calls.some(([name]) => name === 'claim' || name === 'ban'));
  }
});

test('account changes during token refresh cannot authorize ban', async () => {
  const f = fixture();
  let checks = 0;
  f.eligibility.resolve = async () => ({ accountId: ++checks === 1 ? 'first' : 'second' });
  assert.equal((await f.executor.execute(f.input)).reason, 'INELIGIBLE');
  assert.ok(!f.calls.some(([name]) => name === 'claim' || name === 'ban'));
});

test('a lost claim never sends or completes another attempt', async () => {
  const f = fixture();
  f.store.claim = async () => null;
  assert.equal((await f.executor.execute(f.input)).reason, 'DISPATCH_BLOCKED');
  assert.ok(!f.calls.some(([name]) => name === 'ban' || name === 'complete'));
});

test('revocation or eligibility failure after claim records NOT_SENT', async () => {
  for (const unavailable of [false, true]) {
    const f = fixture();
    let checks = 0;
    f.eligibility.resolve = async () => {
      if (++checks < 3) return { accountId: 'persisted-account' };
      if (unavailable) throw Error('database unavailable');
      return null;
    };
    const result = await f.executor.execute(f.input);
    assert.equal(result.result.status, 'NOT_SENT');
    assert.ok(!f.calls.some(([name]) => name === 'ban'));
  }
});

test('cancellation before work and during token refresh prevents a claim', async () => {
  for (const before of [true, false]) {
    const f = fixture();
    const controller = new AbortController();
    if (before) controller.abort();
    else
      f.tokens.accessToken = async () => {
        controller.abort();
        return 'test-token';
      };
    const result = await f.executor.execute({ ...f.input, signal: controller.signal });
    assert.equal(result.reason, 'CANCELLED');
    assert.ok(!f.calls.some(([name]) => name === 'claim' || name === 'ban'));
  }
});

test('cancellation after claim and expired deadlines never dispatch', async () => {
  for (const expired of [true, false]) {
    const f = fixture();
    const controller = new AbortController();
    f.store.claim = async () => {
      if (expired) f.claim.deadline_at = new Date(0).toISOString();
      else controller.abort();
      return f.claim;
    };
    const result = await f.executor.execute({ ...f.input, signal: controller.signal });
    assert.equal(result.result.status, 'NOT_SENT');
    assert.ok(!f.calls.some(([name]) => name === 'ban'));
  }
});

test('transport exceptions are UNKNOWN and never automatically retried', async () => {
  const f = fixture();
  let sends = 0;
  f.adapter.banUser = async () => {
    sends++;
    throw Error('private details');
  };
  const result = await f.executor.execute(f.input);
  assert.deepEqual(result.result, {
    status: 'UNKNOWN',
    http_status: null,
    code: 'TRANSPORT_ERROR',
  });
  assert.equal(sends, 1);
});

test('failed or late persistence never reports confirmed success or redispatches', async () => {
  for (const fails of [true, false]) {
    const f = fixture();
    f.store.complete = async () => {
      if (fails) throw Error('commit uncertain');
      return false;
    };
    assert.deepEqual(await f.executor.execute(f.input), {
      status: 'RESULT_NOT_RECORDED',
      attemptId: 'attempt',
    });
    assert.equal(f.calls.filter(([name]) => name === 'ban').length, 1);
  }
});

test('timeout converts the persisted duration and BAN omits it', async () => {
  for (const action of ['TIMEOUT', 'BAN']) {
    const f = fixture();
    f.execution.action = action;
    f.execution.duration_seconds = action === 'TIMEOUT' ? '300' : null;
    const result = await f.executor.execute(f.input);
    const request = f.calls.find(([name]) => name === 'ban')[1];
    assert.equal(request.action, action);
    assert.equal(request.liveChatId, 'persisted-chat');
    assert.equal(request.durationSeconds, action === 'TIMEOUT' ? 300 : undefined);
    assert.equal(result.result.ban_id, 'provider-ban');
  }
});

test('actor lookup and moderation use the same token and capture the original account', async () => {
  const f = fixture();

  await f.executor.execute(f.input);

  const lookup = f.calls.find(([name]) => name === 'actor');
  const dispatch = f.calls.find(([name]) => name === 'ban');
  const claimCall = f.calls.find(([name]) => name === 'claim');

  assert.equal(lookup[1], 'test-token');
  assert.equal(dispatch[1].accessToken, lookup[1]);

  assert.deepEqual(claimCall, [
    'claim',
    'execution',
    'owner',
    30,
    {
      accountId: 'persisted-account',
      moderatorChannelId: `UC${'a'.repeat(22)}`,
    },
  ]);
});

test('unresolved or failed actor lookup never claims or dispatches', async () => {
  for (const throws of [false, true]) {
    const f = fixture();

    f.actors.resolve = async () => {
      if (throws) {
        throw new Error('Private identity lookup details');
      }

      return {
        status: 'UNRESOLVED',
        code: 'AMBIGUOUS_IDENTITY',
        httpStatus: 200,
      };
    };

    assert.deepEqual(await f.executor.execute(f.input), {
      status: 'SKIPPED',
      reason: 'ACTOR_UNAVAILABLE',
    });

    assert.equal(
      f.calls.some(([name]) => ['claim', 'ban', 'complete'].includes(name)),
      false,
    );
  }
});

test('cancellation during actor lookup never creates an attempt', async () => {
  const f = fixture();
  const controller = new AbortController();

  f.actors.resolve = async (_accessToken, signal) => {
    assert.equal(signal, controller.signal);
    controller.abort();

    return {
      status: 'RESOLVED',
      channelId: `UC${'a'.repeat(22)}`,
    };
  };

  assert.deepEqual(
    await f.executor.execute({
      ...f.input,
      signal: controller.signal,
    }),
    {
      status: 'SKIPPED',
      reason: 'CANCELLED',
    },
  );

  assert.equal(
    f.calls.some(([name]) => ['claim', 'ban', 'complete'].includes(name)),
    false,
  );
});

test('authorization is rechecked after actor lookup', async () => {
  const f = fixture();
  let revoked = false;

  f.eligibility.resolve = async () => (revoked ? null : { accountId: 'persisted-account' });

  f.actors.resolve = async () => {
    revoked = true;

    return {
      status: 'RESOLVED',
      channelId: `UC${'a'.repeat(22)}`,
    };
  };

  assert.deepEqual(await f.executor.execute(f.input), {
    status: 'SKIPPED',
    reason: 'INELIGIBLE',
  });

  assert.equal(
    f.calls.some(([name]) => ['claim', 'ban', 'complete'].includes(name)),
    false,
  );
});
