const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');

const { DeleteExecutionStore } = source('apps/worker/src/ingestion/delete-execution-store.ts');
const { BanExecutionStore } = source('apps/worker/src/ingestion/ban-execution-store.ts');
const { BanEligibilityStore } = source('apps/worker/src/ingestion/ban-eligibility-store.ts');
const { BanExecutor } = source('apps/worker/src/ingestion/ban-executor.ts');
const { YoutubeBanAdapter } = source('packages/provider-adapters/src/youtube-ban.ts');
const { DeleteCandidateStore } = source('apps/worker/src/ingestion/delete-candidate-store.ts');
const { DeleteEligibilityStore } = source('apps/worker/src/ingestion/delete-eligibility-store.ts');
const { DeleteExecutor } = source('apps/worker/src/ingestion/delete-executor.ts');
const { YoutubeModerationAdapter } = source('packages/provider-adapters/src/youtube-moderation.ts');
const { readLiveEvents } = source('packages/persistence/src/live-events.ts');
const { consumeLiveFrame } = source('apps/dashboard/features/live/lib/live-event-protocol.ts');
const { BanCandidateStore } = source('apps/worker/src/ingestion/ban-candidate-store.ts');
const { BAN_DISPATCH_BLOCK_REASON_SQL } = source('packages/persistence/src/ban-dispatch-policy.ts');
const { BanEvidenceReader } = source('apps/worker/src/ingestion/ban-evidence-reader.ts');
const { BanEvidenceStore } = source('apps/worker/src/ingestion/ban-evidence-store.ts');
const { BanEvidenceCoordinator } = source('apps/worker/src/ingestion/ban-evidence-coordinator.ts');

const schema = `delete_store_${randomUUID().replaceAll('-', '')}`;
const role = `delete_worker_${randomUUID().replaceAll('-', '')}`;
let admin;
let pool;
let store;
let schemaCreated = false;
let roleCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
  }
  const { migrate } = await import('../scripts/database.mjs');
  const { provisionWorkerRole } = await import('../scripts/worker-role.mjs');
  admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await admin.query(`SET search_path TO ${schema}`);
  await migrate(admin);
  await provisionWorkerRole(admin, { role, password: randomUUID(), schema });
  roleCreated = true;
  pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${role}`,
    max: 4,
    statement_timeout: 5000,
  });
  store = new DeleteExecutionStore(pool);
});

after(async () => {
  try {
    if (pool) await pool.end();
  } finally {
    if (admin) {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        if (roleCreated) await admin.query(`DROP ROLE ${role}`);
      } finally {
        await admin.end();
      }
    }
  }
});

async function fixture(action = 'DELETE', policyVersion = 'test-actions-1') {
  const f = {
    accountId: randomUUID(),
    channelId: randomUUID(),
    sessionId: randomUUID(),
    runId: randomUUID(),
    observationId: randomUUID(),
    classificationId: randomUUID(),
    planId: randomUUID(),
    externalMessageId: `message-${randomUUID()}`,
  };
  await admin.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    f.accountId,
    'Delete store test',
  ]);
  await admin.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
    f.channelId,
    'Delete store channel',
  ]);
  await admin.query('INSERT INTO youtube_channels(channel_id, youtube_channel_id) VALUES($1, $2)', [
    f.channelId,
    `channel-${randomUUID()}`,
  ]);
  await admin.query(
    "INSERT INTO stream_sessions(id, channel_id, label, source) VALUES($1, $2, 'Deletion test', 'YOUTUBE')",
    [f.sessionId, f.channelId],
  );
  await admin.query(
    'INSERT INTO youtube_broadcasts(session_id, channel_id, youtube_broadcast_id, live_chat_id) VALUES($1, $2, $3, $4)',
    [f.sessionId, f.channelId, `broadcast-${randomUUID()}`, `chat-${randomUUID()}`],
  );
  await admin.query(
    'INSERT INTO monitoring_runs(id, channel_id, session_id, requested_by_account_id, credential_account_id) VALUES($1, $2, $3, $4, $4)',
    [f.runId, f.channelId, f.sessionId, f.accountId],
  );
  await admin.query(
    `INSERT INTO youtube_chat_observations(id, channel_id, session_id, first_observed_run_id,
      external_message_id, event_type, published_at, payload, payload_hash)
     VALUES($1, $2, $3, $4, $5, 'textMessageEvent', clock_timestamp(), '{"authorDetails":{"channelId":"test-author"}}'::jsonb, $6)`,
    [f.observationId, f.channelId, f.sessionId, f.runId, f.externalMessageId, 'a'.repeat(64)],
  );
  await admin.query(
    `INSERT INTO youtube_chat_classifications(id, channel_id, session_id, observation_id, run_id,
      classifier_version, policy_version, outcome, primary_category, severity, reason_code, reason, signals)
     VALUES($1, $2, $3, $4, $5, 'test-rules-1', 'test-policy-1', 'REVIEW', 'HARASSMENT',
      2, 'DIRECT_INSULT', 'Deletion store fixture.', '[]'::jsonb)`,
    [f.classificationId, f.channelId, f.sessionId, f.observationId, f.runId],
  );
  await insertPlan(f, f.planId, policyVersion, action);
  return f;
}

async function insertPlan(f, id, version, action = 'DELETE') {
  await admin.query(
    `INSERT INTO youtube_moderation_action_plans(id, channel_id, session_id, classification_id,
      policy_version, action, reason, duration_seconds) VALUES($1, $2, $3, $4, $5, $6, 'Deletion store fixture.', CASE WHEN $6 = 'TIMEOUT' THEN 300 ELSE NULL END)`,
    [id, f.channelId, f.sessionId, f.classificationId, version, action],
  );
}

async function execution(f) {
  return store.ensure(f.planId, f.channelId, f.sessionId);
}

async function eventsFor(row) {
  const result = await admin.query(
    'SELECT sequence::text, event_type, run_id FROM live_events WHERE channel_id = $1 AND session_id = $2 ORDER BY sequence',
    [row.channel_id, row.session_id],
  );
  return result.rows;
}

test('ban store derives targets and reuses identical concurrent plans with worker permissions', async () => {
  const f = await fixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);
  const rows = await allResults([
    bans.ensure(f.planId, f.channelId, f.sessionId),
    bans.ensure(f.planId, f.channelId, f.sessionId),
  ]);
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(rows[0].author_channel_id, 'test-author');
  assert.equal(rows[0].duration_seconds, '300');
  const next = randomUUID();
  await insertPlan(f, next, 'ban-store-policy-2', 'TIMEOUT');
  assert.equal((await bans.ensure(next, f.channelId, f.sessionId)).plan_id, f.planId);
  const escalation = randomUUID();
  await insertPlan(f, escalation, 'ban-store-policy-3', 'BAN');
  await assert.rejects(bans.ensure(escalation, f.channelId, f.sessionId), /incompatible/);
  await assert.rejects(bans.ensure(f.planId, randomUUID(), f.sessionId), /scoped/);
  const wrong = await fixture('DELETE');
  await assert.rejects(bans.ensure(wrong.planId, wrong.channelId, wrong.sessionId), /scoped/);
});

test('ban store serializes claims and results and preserves provider ban identity', async () => {
  const f = await fixture('BAN');
  const bans = new BanExecutionStore(pool);
  const row = await bans.ensure(f.planId, f.channelId, f.sessionId);
  const claims = await allResults([
    bans.claim(row.id, randomUUID()),
    bans.claim(row.id, randomUUID()),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claim = claims.find(Boolean);
  const success = { status: 'SUCCEEDED', http_status: 200, ban_id: 'provider-ban-1' };
  assert.equal(await bans.complete({ ...claim, owner_id: randomUUID() }, success), false);
  assert.equal(
    await bans.complete({ ...claim, execution: { ...row, id: randomUUID() } }, success),
    false,
  );
  assert.deepEqual(
    (await allResults([bans.complete(claim, success), bans.complete(claim, success)])).sort(),
    [false, true],
  );
  const result = await admin.query('SELECT status,ban_id FROM youtube_ban_attempts WHERE id=$1', [
    claim.attempt_id,
  ]);
  assert.deepEqual(result.rows[0], { status: 'SUCCEEDED', ban_id: 'provider-ban-1' });
  assert.equal(await bans.claim(row.id, randomUUID()), null);
  assert.equal((await eventsFor(row)).length, 2);
});

test('timeout rejection cannot use DELETE rate-limit retry policy', async () => {
  const f = await fixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);
  const row = await bans.ensure(f.planId, f.channelId, f.sessionId);
  const claim = await bans.claim(row.id, randomUUID());
  await bans.complete(claim, {
    status: 'REJECTED',
    http_status: 429,
    code: 'YOUTUBE_RATE_LIMITED',
  });
  assert.equal(await new BanExecutionStore(pool).claim(row.id, randomUUID()), null);
});

test('ban recovery records unknown once and rejects late completion', async () => {
  const f = await fixture('BAN');
  const bans = new BanExecutionStore(pool);
  const row = await bans.ensure(f.planId, f.channelId, f.sessionId);
  const claim = {
    execution: row,
    attempt_id: randomUUID(),
    owner_id: randomUUID(),
    deadline_at: '2020-01-01T00:00:30Z',
  };
  await admin.query(
    `INSERT INTO youtube_ban_attempts(id,execution_id,owner_id,started_at,deadline_at)
     VALUES($1,$2,$3,'2020-01-01T00:00:00Z','2020-01-01T00:00:30Z')`,
    [claim.attempt_id, row.id, claim.owner_id],
  );
  const success = { status: 'SUCCEEDED', http_status: 200, ban_id: 'late-ban' };
  assert.equal(await bans.complete(claim, success), false);
  const counts = await allResults([bans.recoverExpired(), bans.recoverExpired()]);
  assert.equal(
    counts.reduce((sum, n) => sum + n, 0),
    1,
  );
  assert.equal(await bans.complete(claim, success), false);
  assert.equal(await bans.claim(row.id, randomUUID()), null);
  const result = await admin.query(
    'SELECT status,ban_id,error_code FROM youtube_ban_attempts WHERE id=$1',
    [claim.attempt_id],
  );
  assert.deepEqual(result.rows[0], {
    status: 'UNKNOWN',
    ban_id: null,
    error_code: 'EXECUTION_DEADLINE_EXCEEDED',
  });
  assert.equal((await eventsFor(row)).length, 1);
});

test('ban result publication failure rolls back status and provider identity', async () => {
  const f = await fixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);
  const row = await bans.ensure(f.planId, f.channelId, f.sessionId);
  const claim = await bans.claim(row.id, randomUUID(), 300);
  const success = { status: 'SUCCEEDED', http_status: 200, ban_id: 'rollback-ban' };
  await admin.query(`REVOKE INSERT ON ${schema}.live_events FROM ${role}`);
  try {
    await assert.rejects(bans.complete(claim, success), { code: '42501' });
  } finally {
    await admin.query(`GRANT INSERT ON ${schema}.live_events TO ${role}`);
  }
  const result = await admin.query('SELECT status,ban_id FROM youtube_ban_attempts WHERE id=$1', [
    claim.attempt_id,
  ]);
  assert.deepEqual(result.rows[0], { status: 'DISPATCHED', ban_id: null });
  assert.equal((await eventsFor(row)).length, 1);
  assert.equal(await bans.complete(claim, success), true);
  assert.deepEqual(
    (await eventsFor(row)).map((event) => event.sequence),
    ['1', '2'],
  );
});

async function seedPastRateLimit(row, number) {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO youtube_delete_attempts(id, execution_id, attempt_number, owner_id, started_at, deadline_at)
     VALUES($1, $2, $3, $4, '2020-01-01T00:00:00Z', '2020-01-01T00:00:30Z')`,
    [id, row.id, number, randomUUID()],
  );
  await admin.query(
    `UPDATE youtube_delete_attempts SET status = 'REJECTED', http_status = 429,
     error_code = 'YOUTUBE_RATE_LIMITED', finished_at = '2020-01-01T00:00:01Z' WHERE id = $1`,
    [id],
  );
}

test('retry backoff distinguishes attempts one and two and rejects mismatched outcomes', async () => {
  const { DELETE_RETRY_DUE_SQL } = source('apps/worker/src/ingestion/delete-retry-policy.ts');
  for (const [number, seconds, status, http, code, expected] of [
    [1, 30, 'REJECTED', 429, 'YOUTUBE_RATE_LIMITED', false],
    [1, 90, 'REJECTED', 429, 'YOUTUBE_RATE_LIMITED', true],
    [2, 90, 'REJECTED', 429, 'YOUTUBE_RATE_LIMITED', false],
    [2, 180, 'REJECTED', 429, 'YOUTUBE_RATE_LIMITED', true],
    [3, 180, 'REJECTED', 429, 'YOUTUBE_RATE_LIMITED', false],
    [1, 180, 'UNKNOWN', 429, 'YOUTUBE_RATE_LIMITED', false],
    [1, 180, 'REJECTED', 403, 'YOUTUBE_RATE_LIMITED', false],
    [1, 180, 'REJECTED', 429, 'YOUTUBE_FORBIDDEN', false],
  ]) {
    const result = await pool.query(
      `SELECT ${DELETE_RETRY_DUE_SQL} AS due FROM (
        SELECT $1::integer AS attempt_number, clock_timestamp() - $2::integer * interval '1 second' AS finished_at,
        $3::text AS status, $4::integer AS http_status, $5::text AS error_code
      ) a`,
      [number, seconds, status, http, code],
    );
    assert.equal(result.rows[0].due, expected);
  }
});

test('a due retry traverses the real executor and preserves the prior rejection', async () => {
  const f = await eligibleFixture();
  await seedPastRateLimit(f.execution, 1);
  let sends = 0;
  const result = await integratedExecutor(f, async () => {
    sends++;
    return new Response(null, { status: 204 });
  }).execute(executeInput(f));
  assert.equal(result.status, 'RECORDED');
  assert.equal(result.result.status, 'SUCCEEDED');
  assert.equal(sends, 1);
  const attempts = await admin.query(
    'SELECT attempt_number, status FROM youtube_delete_attempts WHERE execution_id = $1 ORDER BY attempt_number',
    [f.execution.id],
  );
  assert.deepEqual(attempts.rows, [
    { attempt_number: 1, status: 'REJECTED' },
    { attempt_number: 2, status: 'SUCCEEDED' },
  ]);
  assert.equal((await eventsFor(f.execution)).length, 2);
});

test('fresh rate-limit rejection is not immediately redispatched', async () => {
  const f = await eligibleFixture();
  const claim = await store.claim(f.execution.id, randomUUID());
  await store.complete(claim, {
    status: 'REJECTED',
    http_status: 429,
    code: 'YOUTUBE_RATE_LIMITED',
  });
  assert.equal(await new DeleteExecutionStore(pool).claim(f.execution.id, randomUUID()), null);
});

test('due retry discovery and concurrent claims share the persisted budget', async () => {
  const f = await eligibleFixture();
  await seedPastRateLimit(f.execution, 1);
  const candidates = new DeleteCandidateStore(pool);
  let cursor = null;
  let found = false;
  for (;;) {
    const candidate = await candidates.next(cursor);
    if (!candidate) break;
    cursor = candidate.planId;
    if (candidate.planId === f.planId) found = true;
  }
  assert.equal(found, true);
  const claims = await allResults([
    new DeleteExecutionStore(pool).claim(f.execution.id, randomUUID()),
    new DeleteExecutionStore(pool).claim(f.execution.id, randomUUID()),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claim = claims.find(Boolean);
  const attempt = await admin.query(
    'SELECT attempt_number FROM youtube_delete_attempts WHERE id = $1',
    [claim.attempt_id],
  );
  assert.equal(attempt.rows[0].attempt_number, 2);
  await store.complete(claim, { status: 'SUCCEEDED', http_status: 204 });
  assert.equal(await store.claim(f.execution.id, randomUUID()), null);
});

test('three rate-limit rejections exhaust the budget across restarts and policy versions', async () => {
  const f = await eligibleFixture();
  for (let n = 1; n <= 3; n++) await seedPastRateLimit(f.execution, n);
  const nextPlan = randomUUID();
  await insertPlan(f, nextPlan, 'retry-policy-version-2');
  const fresh = new DeleteExecutionStore(pool);
  const reused = await fresh.ensure(nextPlan, f.channelId, f.sessionId);
  assert.equal(reused.id, f.execution.id);
  assert.equal(await fresh.claim(reused.id, randomUUID()), null);
});

test('an eligible third attempt is numbered three and cannot be followed by a fourth', async () => {
  const f = await eligibleFixture();
  await seedPastRateLimit(f.execution, 1);
  await seedPastRateLimit(f.execution, 2);
  const claim = await store.claim(f.execution.id, randomUUID());
  assert.ok(claim);
  const stored = await admin.query(
    'SELECT attempt_number FROM youtube_delete_attempts WHERE id = $1',
    [claim.attempt_id],
  );
  assert.equal(stored.rows[0].attempt_number, 3);
  await store.complete(claim, {
    status: 'REJECTED',
    http_status: 429,
    code: 'YOUTUBE_RATE_LIMITED',
  });
  assert.equal(await store.claim(f.execution.id, randomUUID()), null);
});

test('a due retry still requires current monitoring authorization', async () => {
  const f = await eligibleFixture();
  await seedPastRateLimit(f.execution, 1);
  await admin.query(
    "UPDATE monitoring_runs SET status = 'STOPPING', stop_requested_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
  let sends = 0;
  const executor = integratedExecutor(f, async () => {
    sends++;
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(await executor.execute(executeInput(f)), {
    status: 'SKIPPED',
    reason: 'INELIGIBLE',
  });
  assert.equal(sends, 0);
  const attempts = await admin.query(
    'SELECT id FROM youtube_delete_attempts WHERE execution_id = $1',
    [f.execution.id],
  );
  assert.equal(attempts.rows.length, 1);
});

async function allResults(promises) {
  const settled = await Promise.allSettled(promises);
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

async function eligibleFixture(action = 'DELETE', policyVersion = 'test-actions-1') {
  const f = await fixture(action, policyVersion);
  await admin.query(
    "UPDATE monitoring_runs SET status = 'RUNNING', started_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
  await admin.query(
    "INSERT INTO channel_memberships(channel_id, account_id, role) VALUES($1, $2, 'OWNER')",
    [f.channelId, f.accountId],
  );
  await admin.query('INSERT INTO youtube_chat_checkpoints(session_id) VALUES($1)', [f.sessionId]);
  await admin.query(
    `INSERT INTO google_credentials(account_id, access_token_ciphertext, refresh_token_ciphertext, expires_at, scopes)
     VALUES($1, 'test-only', 'test-only', clock_timestamp() - interval '1 hour', $2)`,
    [f.accountId, 'openid https://www.googleapis.com/auth/youtube.force-ssl'],
  );
  return {
    ...f,
    execution:
      action === 'DELETE'
        ? await execution(f)
        : await new BanExecutionStore(pool).ensure(f.planId, f.channelId, f.sessionId),
  };
}

test('ban eligibility validates target fields, memberships, scope, and active original run', async () => {
  for (const action of ['TIMEOUT', 'BAN']) {
    const f = await eligibleFixture(action);
    const eligibility = new BanEligibilityStore(pool, () => true);
    assert.deepEqual(await eligibility.resolve(f.execution), { accountId: f.accountId });
    assert.equal(await new BanEligibilityStore(pool, () => false).resolve(f.execution), null);
    for (const change of [
      { id: randomUUID() },
      { plan_id: randomUUID() },
      { channel_id: randomUUID() },
      { session_id: randomUUID() },
      { live_chat_id: 'other' },
      { author_channel_id: 'other' },
      { action: action === 'BAN' ? 'TIMEOUT' : 'BAN' },
      { duration_seconds: '10' },
    ]) {
      assert.equal(await eligibility.resolve({ ...f.execution, ...change }), null);
    }
    await admin.query(
      "UPDATE google_credentials SET scopes='https://www.googleapis.com/auth/youtube.readonly' WHERE account_id=$1",
      [f.accountId],
    );
    assert.equal(await eligibility.resolve(f.execution), null);
    await admin.query(
      "UPDATE google_credentials SET scopes='https://www.googleapis.com/auth/youtube.force-ssl' WHERE account_id=$1",
      [f.accountId],
    );
    await admin.query("UPDATE channel_memberships SET role='OPERATOR' WHERE channel_id=$1", [
      f.channelId,
    ]);
    assert.equal(await eligibility.resolve(f.execution), null);
    await admin.query("UPDATE channel_memberships SET role='OWNER' WHERE channel_id=$1", [
      f.channelId,
    ]);
    await admin.query(
      'UPDATE youtube_chat_checkpoints SET chat_ended_at=clock_timestamp() WHERE session_id=$1',
      [f.sessionId],
    );
    assert.equal(await eligibility.resolve(f.execution), null);
    await admin.query(
      'UPDATE youtube_chat_checkpoints SET chat_ended_at=NULL WHERE session_id=$1',
      [f.sessionId],
    );
    await admin.query(
      "UPDATE monitoring_runs SET status='STOPPING', stop_requested_at=clock_timestamp() WHERE id=$1",
      [f.runId],
    );
    assert.equal(await eligibility.resolve(f.execution), null);
  }
});

test('ban executor integration persists confirmed targets and never redispatches', async () => {
  for (const action of ['TIMEOUT', 'BAN']) {
    const f = await eligibleFixture(action);
    const requests = [];
    const executor = new BanExecutor(
      new BanExecutionStore(pool),
      new BanEligibilityStore(pool, () => true),
      {
        async accessToken(accountId) {
          assert.equal(accountId, f.accountId);
          return 'test-token';
        },
      },
      new YoutubeBanAdapter(async (_url, init) => {
        const snapshot = await admin.query(
          `
    SELECT credential_account_id, moderator_channel_id, status
    FROM youtube_ban_attempts
    WHERE execution_id = $1
  `,
          [f.execution.id],
        );

        assert.deepEqual(snapshot.rows, [
          {
            credential_account_id: f.accountId,
            moderator_channel_id: `UC${'a'.repeat(22)}`,
            status: 'DISPATCHED',
          },
        ]);

        assert.equal(init.headers.Authorization, 'Bearer test-token');
        const body = JSON.parse(init.body);
        requests.push(body);
        return Response.json({
          kind: 'youtube#liveChatBan',
          id: 'confirmed-ban',
          snippet: body.snippet,
        });
      }),
      {
        async resolve(accessToken) {
          assert.equal(accessToken, 'test-token');

          return {
            status: 'RESOLVED',
            channelId: `UC${'a'.repeat(22)}`,
          };
        },
      },
    );
    const result = await executor.execute(executeInput(f));
    assert.equal(result.status, 'RECORDED');
    assert.equal(result.result.ban_id, 'confirmed-ban');
    assert.equal(requests[0].snippet.liveChatId, f.execution.live_chat_id);
    assert.equal(requests[0].snippet.bannedUserDetails.channelId, 'test-author');
    assert.equal(requests[0].snippet.banDurationSeconds, action === 'TIMEOUT' ? 300 : undefined);
    const stored = await admin.query(
      'SELECT ban_id,status FROM youtube_ban_attempts WHERE execution_id=$1',
      [f.execution.id],
    );
    assert.deepEqual(stored.rows[0], { ban_id: 'confirmed-ban', status: 'SUCCEEDED' });
    assert.equal((await executor.execute(executeInput(f))).reason, 'DISPATCH_BLOCKED');
    assert.equal(requests.length, 1);
  }
});

function integratedExecutor(f, transport, tokenHook = async () => {}) {
  return new DeleteExecutor(
    new DeleteExecutionStore(pool),
    new DeleteEligibilityStore(pool, () => true),
    {
      async accessToken(accountId) {
        assert.equal(accountId, f.accountId);
        await tokenHook();
        return 'test-access-token';
      },
    },
    new YoutubeModerationAdapter(transport),
  );
}

function executeInput(f) {
  return {
    planId: f.planId,
    channelId: f.channelId,
    sessionId: f.sessionId,
    ownerId: randomUUID(),
  };
}

test('integration: competing executors send once after commit and publish replayable chat updates', async () => {
  const f = await eligibleFixture();
  const requests = [];
  const transport = async (url, options) => {
    // A separate connection must already see the claim before the provider boundary is called.
    const persisted = await admin.query(
      'SELECT status FROM youtube_delete_attempts WHERE execution_id = $1',
      [f.execution.id],
    );
    requests.push({ url, options, statuses: persisted.rows.map((row) => row.status) });
    return new Response(null, { status: 204 });
  };
  const results = await allResults([
    integratedExecutor(f, transport).execute(executeInput(f)),
    integratedExecutor(f, transport).execute(executeInput(f)),
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].statuses, ['DISPATCHED']);
  assert.equal(requests[0].options.method, 'DELETE');
  assert.equal(new URL(requests[0].url).searchParams.get('id'), f.externalMessageId);
  assert.equal(results.filter((result) => result.status === 'RECORDED').length, 1);
  assert.equal(results.find((result) => result.status === 'RECORDED').result.status, 'SUCCEEDED');
  assert.equal(results.find((result) => result.status === 'SKIPPED').reason, 'ALREADY_ATTEMPTED');

  const client = await pool.connect();
  let page;
  try {
    page = await readLiveEvents(client, {
      channelId: f.channelId,
      sessionId: f.sessionId,
      after: '0',
    });
  } finally {
    client.release();
  }
  assert.deepEqual(page.items, [
    { sequence: '1', event_type: 'chat.updated', run_id: f.runId },
    { sequence: '2', event_type: 'chat.updated', run_id: f.runId },
  ]);
  const position = consumeLiveFrame(
    JSON.stringify({
      type: 'events',
      channel_id: f.channelId,
      session_id: f.sessionId,
      cursor: page.next_cursor,
      items: page.items,
    }),
    { channelId: f.channelId, sessionId: f.sessionId },
    { cursor: '0', ready: true },
  );
  assert.equal(position.refreshChat, true);
  assert.equal(position.refreshMonitoring, false);
  assert.equal(position.cursor, '2');
  // A fresh executor instance models lost process-local state; the database still blocks redispatch.
  const restarted = await integratedExecutor(f, transport).execute(executeInput(f));
  assert.equal(restarted.reason, 'ALREADY_ATTEMPTED');
  assert.equal(requests.length, 1);
});

test('integration: lost transport response persists UNKNOWN and remains blocked after restart', async () => {
  const f = await eligibleFixture();
  let sends = 0;
  const transport = async () => {
    sends++;
    throw Error('Simulated lost response');
  };
  const first = await integratedExecutor(f, transport).execute(executeInput(f));
  assert.equal(first.status, 'RECORDED');
  assert.equal(first.result.status, 'UNKNOWN');
  const stored = await admin.query(
    'SELECT status, error_code FROM youtube_delete_attempts WHERE execution_id = $1',
    [f.execution.id],
  );
  assert.deepEqual(stored.rows, [{ status: 'UNKNOWN', error_code: 'TRANSPORT_ERROR' }]);
  assert.equal(
    (await integratedExecutor(f, transport).execute(executeInput(f))).reason,
    'ALREADY_ATTEMPTED',
  );
  assert.equal(sends, 1);
  assert.equal((await eventsFor(f.execution)).length, 2);
});

test('integration: monitoring stopped during token acquisition never reaches the provider', async () => {
  const f = await eligibleFixture();
  let sends = 0;
  const executor = integratedExecutor(
    f,
    async () => {
      sends++;
      return new Response(null, { status: 204 });
    },
    async () => {
      await admin.query(
        "UPDATE monitoring_runs SET status = 'STOPPING', stop_requested_at = clock_timestamp() WHERE id = $1",
        [f.runId],
      );
    },
  );
  assert.deepEqual(await executor.execute(executeInput(f)), {
    status: 'SKIPPED',
    reason: 'INELIGIBLE',
  });
  assert.equal(sends, 0);
  const attempts = await admin.query(
    'SELECT id FROM youtube_delete_attempts WHERE execution_id = $1',
    [f.execution.id],
  );
  assert.equal(attempts.rows.length, 0);
  assert.equal((await eventsFor(f.execution)).length, 0);
});

test('candidate discovery uses worker permissions and excludes attempted targets across policy versions', async () => {
  const f = await eligibleFixture();
  const otherPlan = randomUUID();
  await insertPlan(f, otherPlan, 'candidate-actions-2');
  const starting = await fixture();
  const candidates = new DeleteCandidateStore(pool);
  async function scan() {
    const ids = [];
    let cursor = null;
    for (;;) {
      const row = await candidates.next(cursor);
      if (!row) return ids;
      assert.ok(!ids.includes(row.planId), 'The cursor must advance.');
      ids.push(row.planId);
      cursor = row.planId;
    }
  }
  const before = await scan();
  assert.ok(before.includes(f.planId));
  assert.ok(before.includes(otherPlan));
  assert.ok(!before.includes(starting.planId));
  const claim = await store.claim(f.execution.id, randomUUID());
  const after = await scan();
  assert.ok(!after.includes(f.planId));
  assert.ok(!after.includes(otherPlan));
  await store.complete(claim, { status: 'NOT_SENT', code: 'REQUEST_CANCELLED' });
});

test('eligibility resolves original credentials with the worker role and allows token refresh', async () => {
  const f = await eligibleFixture();
  const eligibility = new DeleteEligibilityStore(pool, () => true);
  assert.deepEqual(await eligibility.resolve(f.execution), { accountId: f.accountId });
  await admin.query("UPDATE channel_memberships SET role = 'MODERATOR' WHERE channel_id = $1", [
    f.channelId,
  ]);
  assert.deepEqual(await eligibility.resolve(f.execution), { accountId: f.accountId });
  assert.equal(await new DeleteEligibilityStore(pool, () => false).resolve(f.execution), null);
});

test('controlled test plans require the currently enabled policy scope', async () => {
  const f = await eligibleFixture();
  const planId = randomUUID();
  await insertPlan(f, planId, 'delete-test-fixture');
  // Use a fresh target so the execution retains the controlled plan as its original provenance.
  await admin.query('DELETE FROM youtube_delete_executions WHERE id = $1', [f.execution.id]);
  const row = await store.ensure(planId, f.channelId, f.sessionId);
  assert.equal(await new DeleteEligibilityStore(pool, () => true).resolve(row), null);
  assert.equal(
    await new DeleteEligibilityStore(pool, () => true, 'delete-test-other').resolve(row),
    null,
  );
  assert.deepEqual(
    await new DeleteEligibilityStore(pool, () => true, 'delete-test-fixture').resolve(row),
    { accountId: f.accountId },
  );
});

test('eligibility rejects substituted execution provenance and target', async () => {
  const f = await eligibleFixture();
  const eligibility = new DeleteEligibilityStore(pool, () => true);
  for (const key of ['id', 'plan_id', 'channel_id', 'session_id', 'external_message_id']) {
    assert.equal(await eligibility.resolve({ ...f.execution, [key]: randomUUID() }), null);
  }
});

test('membership revocation and operator access are enforced on subsequent checks', async () => {
  const f = await eligibleFixture();
  const eligibility = new DeleteEligibilityStore(pool, () => true);
  await admin.query("UPDATE channel_memberships SET role = 'OPERATOR' WHERE channel_id = $1", [
    f.channelId,
  ]);
  assert.equal(await eligibility.resolve(f.execution), null);
  await admin.query('DELETE FROM channel_memberships WHERE channel_id = $1', [f.channelId]);
  assert.equal(await eligibility.resolve(f.execution), null);
});

test('the original requester also needs current channel access', async () => {
  const f = await eligibleFixture();
  const requester = randomUUID();
  await admin.query("INSERT INTO accounts(id, display_name) VALUES($1, 'Other requester')", [
    requester,
  ]);
  await admin.query('UPDATE monitoring_runs SET requested_by_account_id = $1 WHERE id = $2', [
    requester,
    f.runId,
  ]);
  const eligibility = new DeleteEligibilityStore(pool, () => true);
  assert.equal(await eligibility.resolve(f.execution), null);
  await admin.query(
    "INSERT INTO channel_memberships(channel_id, account_id, role) VALUES($1, $2, 'MODERATOR')",
    [f.channelId, requester],
  );
  assert.deepEqual(await eligibility.resolve(f.execution), { accountId: f.accountId });
});

test('scope tokens must match exactly and missing credentials deny execution', async () => {
  const f = await eligibleFixture();
  const eligibility = new DeleteEligibilityStore(pool, () => true);
  for (const scope of [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl.invalid',
    '',
  ]) {
    await admin.query('UPDATE google_credentials SET scopes = $1 WHERE account_id = $2', [
      scope,
      f.accountId,
    ]);
    assert.equal(await eligibility.resolve(f.execution), null);
  }
  await admin.query('UPDATE google_credentials SET scopes = $1 WHERE account_id = $2', [
    'openid\nhttps://www.googleapis.com/auth/youtube',
    f.accountId,
  ]);
  assert.deepEqual(await eligibility.resolve(f.execution), { accountId: f.accountId });
  await admin.query('DELETE FROM google_credentials WHERE account_id = $1', [f.accountId]);
  assert.equal(await eligibility.resolve(f.execution), null);
});

test('missing checkpoints, ended chats, and closed sessions block deletion', async () => {
  const f = await eligibleFixture();
  const eligibility = new DeleteEligibilityStore(pool, () => true);
  await admin.query('DELETE FROM youtube_chat_checkpoints WHERE session_id = $1', [f.sessionId]);
  assert.equal(await eligibility.resolve(f.execution), null);
  await admin.query(
    'INSERT INTO youtube_chat_checkpoints(session_id, chat_ended_at) VALUES($1, clock_timestamp())',
    [f.sessionId],
  );
  assert.equal(await eligibility.resolve(f.execution), null);
  await admin.query(
    'UPDATE youtube_chat_checkpoints SET chat_ended_at = NULL WHERE session_id = $1',
    [f.sessionId],
  );
  await admin.query('UPDATE stream_sessions SET closed_at = clock_timestamp() WHERE id = $1', [
    f.sessionId,
  ]);
  assert.equal(await eligibility.resolve(f.execution), null);
});

test('stopped original runs cannot borrow eligibility from a restarted run', async () => {
  const f = await eligibleFixture();
  const eligibility = new DeleteEligibilityStore(pool, () => true);
  await admin.query(
    "UPDATE monitoring_runs SET status = 'STOPPING', stop_requested_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
  assert.equal(await eligibility.resolve(f.execution), null);
  await admin.query(
    "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
  await admin.query(
    `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
     INSERT INTO monitoring_runs(id, channel_id, session_id, requested_by_account_id, credential_account_id,
      status, requested_at, started_at) SELECT $1, $2, $3, $4, $4, 'RUNNING', at, at FROM moment`,
    [randomUUID(), f.channelId, f.sessionId, f.accountId],
  );
  assert.equal(await eligibility.resolve(f.execution), null);
});

test('concurrent creation and another policy version reuse one execution under worker permissions', async () => {
  const f = await fixture();
  const [first, second] = await allResults([execution(f), execution(f)]);
  assert.equal(first.id, second.id);
  assert.equal(first.external_message_id, f.externalMessageId);
  const another = randomUUID();
  await insertPlan(f, another, 'test-actions-2');
  const reused = await store.ensure(another, f.channelId, f.sessionId);
  assert.equal(reused.id, first.id);
  assert.equal(reused.plan_id, f.planId);
});

test('NONE plans and substituted scopes cannot create executions', async () => {
  await assert.rejects(execution(await fixture('NONE')), /DELETE plan/);
  const f = await fixture();
  await assert.rejects(store.ensure(f.planId, randomUUID(), f.sessionId), /DELETE plan/);
  await assert.rejects(store.ensure(f.planId, f.channelId, randomUUID()), /DELETE plan/);
});

test('only one concurrent owner receives a durable dispatch claim', async () => {
  const f = await fixture();
  const row = await execution(f);
  const claims = await allResults([
    store.claim(row.id, randomUUID()),
    store.claim(row.id, randomUUID()),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claim = claims.find(Boolean);
  const stored = await admin.query(
    'SELECT owner_id, status FROM youtube_delete_attempts WHERE id = $1',
    [claim.attempt_id],
  );
  assert.deepEqual(stored.rows[0], { owner_id: claim.owner_id, status: 'DISPATCHED' });
  assert.equal(await store.complete(claim, { status: 'SUCCEEDED', http_status: 204 }), true);
  assert.equal(await store.claim(row.id, randomUUID()), null);
  assert.deepEqual(await eventsFor(row), [
    { sequence: '1', event_type: 'chat.updated', run_id: f.runId },
    { sequence: '2', event_type: 'chat.updated', run_id: f.runId },
  ]);
});

test('wrong owners and substituted attempts cannot complete a claim', async () => {
  const first = await store.claim((await execution(await fixture())).id, randomUUID());
  const second = await store.claim((await execution(await fixture())).id, randomUUID());
  const success = { status: 'SUCCEEDED', http_status: 204 };
  assert.equal(await store.complete({ ...first, owner_id: randomUUID() }, success), false);
  assert.equal(await store.complete({ ...first, execution: second.execution }, success), false);
  assert.equal(await store.complete(first, success), true);
  assert.equal(await store.complete(first, success), false);
  assert.equal(
    await store.complete(second, { status: 'UNKNOWN', http_status: null, code: 'TRANSPORT_ERROR' }),
    true,
  );
});

test('concurrent completion records only one terminal result', async () => {
  const claim = await store.claim((await execution(await fixture())).id, randomUUID());
  const success = { status: 'SUCCEEDED', http_status: 204 };
  const results = await allResults([
    store.complete(claim, success),
    store.complete(claim, success),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal((await eventsFor(claim.execution)).length, 2);
});

for (const result of [
  { status: 'REJECTED', http_status: 404, code: 'MESSAGE_NOT_FOUND' },
  { status: 'NOT_SENT', code: 'REQUEST_CANCELLED' },
  { status: 'UNKNOWN', http_status: null, code: 'TRANSPORT_ERROR' },
]) {
  test(`${result.status} is persisted without implicit retry`, async () => {
    const row = await execution(await fixture());
    const claim = await store.claim(row.id, randomUUID());
    assert.equal(await store.complete(claim, result), true);
    const stored = await admin.query(
      'SELECT status, http_status, error_code FROM youtube_delete_attempts WHERE id = $1',
      [claim.attempt_id],
    );
    assert.deepEqual(stored.rows[0], {
      status: result.status,
      http_status: result.http_status ?? null,
      error_code: result.code,
    });
    assert.equal(await store.claim(row.id, randomUUID()), null);
  });
}

test('crash recovery marks expired attempts unknown and rejects late completion', async () => {
  const row = await execution(await fixture());
  const attemptId = randomUUID();
  const ownerId = randomUUID();
  await admin.query(
    `INSERT INTO youtube_delete_attempts(id, execution_id, attempt_number, owner_id, started_at, deadline_at)
     VALUES($1, $2, 1, $3, '2020-01-01T00:00:00Z', '2020-01-01T00:00:30Z')`,
    [attemptId, row.id, ownerId],
  );
  const lateClaim = {
    execution: row,
    attempt_id: attemptId,
    owner_id: ownerId,
    deadline_at: '2020-01-01T00:00:30Z',
  };
  assert.equal(await store.complete(lateClaim, { status: 'SUCCEEDED', http_status: 204 }), false);
  const live = await store.claim((await execution(await fixture())).id, randomUUID(), 300);
  const recovered = await allResults([store.recoverExpired(), store.recoverExpired()]);
  assert.equal(
    recovered.reduce((sum, n) => sum + n, 0),
    1,
  );
  const stored = await admin.query(
    'SELECT status, error_code FROM youtube_delete_attempts WHERE id = $1',
    [attemptId],
  );
  assert.deepEqual(stored.rows[0], {
    status: 'UNKNOWN',
    error_code: 'EXECUTION_DEADLINE_EXCEEDED',
  });
  assert.equal(await store.claim(row.id, randomUUID()), null);
  assert.equal(await store.complete(lateClaim, { status: 'SUCCEEDED', http_status: 204 }), false);
  assert.equal(await store.complete(live, { status: 'NOT_SENT', code: 'REQUEST_CANCELLED' }), true);
  assert.equal((await eventsFor(row)).length, 1);
  assert.equal((await eventsFor(row))[0].event_type, 'chat.updated');
});

test('event publication failure rolls back claims and terminal results without cursor gaps', async () => {
  const row = await execution(await fixture());
  async function withoutEventPermission(work) {
    await admin.query(`REVOKE INSERT ON ${schema}.live_events FROM ${role}`);
    try {
      await work();
    } finally {
      await admin.query(`GRANT INSERT ON ${schema}.live_events TO ${role}`);
    }
  }
  await withoutEventPermission(async () => {
    await assert.rejects(store.claim(row.id, randomUUID()), { code: '42501' });
  });
  assert.equal((await eventsFor(row)).length, 0);
  const attempts = await admin.query(
    'SELECT id FROM youtube_delete_attempts WHERE execution_id = $1',
    [row.id],
  );
  assert.equal(attempts.rows.length, 0);
  const claim = await store.claim(row.id, randomUUID(), 300);
  const success = { status: 'SUCCEEDED', http_status: 204 };
  await withoutEventPermission(async () => {
    await assert.rejects(store.complete(claim, success), { code: '42501' });
  });
  const attempt = await admin.query('SELECT status FROM youtube_delete_attempts WHERE id = $1', [
    claim.attempt_id,
  ]);
  assert.equal(attempt.rows[0].status, 'DISPATCHED');
  assert.equal((await eventsFor(row)).length, 1);
  assert.equal(await store.complete(claim, success), true);
  assert.deepEqual(
    (await eventsFor(row)).map((event) => event.sequence),
    ['1', '2'],
  );
});

test('recovery and its refresh event roll back together on publication failure', async () => {
  const row = await execution(await fixture());
  const id = randomUUID();
  await admin.query(
    `INSERT INTO youtube_delete_attempts(id, execution_id, attempt_number, owner_id, started_at, deadline_at)
     VALUES($1, $2, 1, $3, '2020-01-01T00:00:00Z', '2020-01-01T00:00:30Z')`,
    [id, row.id, randomUUID()],
  );
  await admin.query(`REVOKE INSERT ON ${schema}.live_events FROM ${role}`);
  try {
    await assert.rejects(store.recoverExpired(), { code: '42501' });
  } finally {
    await admin.query(`GRANT INSERT ON ${schema}.live_events TO ${role}`);
  }
  const attempt = await admin.query('SELECT status FROM youtube_delete_attempts WHERE id = $1', [
    id,
  ]);
  assert.equal(attempt.rows[0].status, 'DISPATCHED');
  assert.equal((await eventsFor(row)).length, 0);
  await store.recoverExpired();
  assert.deepEqual(
    (await eventsFor(row)).map((event) => event.sequence),
    ['1'],
  );
});

test('ban candidates exclude attempted authors and conflicting actions', async () => {
  const f = await eligibleFixture('TIMEOUT');
  const candidates = new BanCandidateStore(pool);
  const bans = new BanExecutionStore(pool);

  async function scan() {
    const ids = [];
    let cursor = null;

    for (;;) {
      const candidate = await candidates.next(cursor);

      if (!candidate) return ids;

      assert.ok(!ids.includes(candidate.planId));
      ids.push(candidate.planId);
      cursor = candidate.planId;
    }
  }

  assert.ok((await scan()).includes(f.planId));

  const conflictingPlan = randomUUID();

  await insertPlan(f, conflictingPlan, 'conflicting-ban-policy', 'BAN');

  assert.equal((await scan()).includes(conflictingPlan), false);

  const claim = await bans.claim(f.execution.id, randomUUID());

  assert.ok(claim);
  assert.equal((await scan()).includes(f.planId), false);

  await bans.complete(claim, {
    status: 'NOT_SENT',
    code: 'REQUEST_CANCELLED',
  });

  assert.equal((await scan()).includes(f.planId), false);
});

test('controlled ban eligibility accepts only the enabled policy version', async () => {
  for (const action of ['TIMEOUT', 'BAN']) {
    const version = 'ban-test-' + 'a'.repeat(64);
    const otherVersion = 'ban-test-' + 'b'.repeat(64);
    const f = await eligibleFixture(action, version);

    assert.equal(await new BanEligibilityStore(pool, () => true).resolve(f.execution), null);

    assert.equal(
      await new BanEligibilityStore(pool, () => true, otherVersion).resolve(f.execution),
      null,
    );

    assert.deepEqual(
      await new BanEligibilityStore(pool, () => true, version).resolve(f.execution),
      { accountId: f.accountId },
    );

    assert.equal(
      await new BanEligibilityStore(pool, () => false, version).resolve(f.execution),
      null,
    );

    const regular = await eligibleFixture(action);

    assert.equal(
      await new BanEligibilityStore(pool, () => true, version).resolve(regular.execution),
      null,
    );
  }
});

async function nextAuthorPlan(
  f,
  { publishedAt = new Date().toISOString(), action = 'TIMEOUT' } = {},
) {
  const next = {
    ...f,
    observationId: randomUUID(),
    classificationId: randomUUID(),
    planId: randomUUID(),
  };

  await admin.query(
    `
      INSERT INTO youtube_chat_observations(
        id, channel_id, session_id, first_observed_run_id,
        external_message_id, event_type, published_at, payload, payload_hash
      )
      SELECT
        $2, channel_id, session_id, first_observed_run_id,
        $3, event_type, $4::timestamptz, payload, payload_hash
      FROM youtube_chat_observations
      WHERE id = $1
    `,
    [f.observationId, next.observationId, `message-${next.observationId}`, publishedAt],
  );

  await admin.query(
    `
      INSERT INTO youtube_chat_classifications(
        id, channel_id, session_id, observation_id, run_id,
        classifier_version, policy_version, outcome,
        primary_category, severity, reason_code, reason, signals
      )
      SELECT
        $2, channel_id, session_id, $3, run_id,
        classifier_version, policy_version, outcome,
        primary_category, severity, reason_code, reason, signals
      FROM youtube_chat_classifications
      WHERE id = $1
    `,
    [f.classificationId, next.classificationId, next.observationId],
  );

  await insertPlan(next, next.planId, 'repeated-action-test', action);
  return next;
}

async function seedHistoricalBanAttempt(executionId, status = 'SUCCEEDED') {
  const id = randomUUID();

  await admin.query(
    `
      INSERT INTO youtube_ban_attempts(
        id, execution_id, owner_id, started_at, deadline_at
      )
      VALUES(
        $1, $2, $3,
        '2020-01-01T00:00:00Z',
        '2020-01-01T00:00:30Z'
      )
    `,
    [id, executionId, randomUUID()],
  );

  await admin.query(
    `
      UPDATE youtube_ban_attempts
      SET status = $2,
          finished_at = '2020-01-01T00:00:01Z',
          http_status = $3,
          error_code = $4,
          ban_id = $5
      WHERE id = $1
    `,
    [
      id,
      status,
      status === 'SUCCEEDED' ? 200 : null,
      status === 'SUCCEEDED' ? null : 'REQUEST_INTERRUPTED',
      status === 'SUCCEEDED' ? 'historical-provider-ban' : null,
    ],
  );
}

async function findBanCandidate(planId) {
  const candidates = new BanCandidateStore(pool);
  let cursor = null;

  for (let count = 0; count < 1000; count++) {
    const candidate = await candidates.next(cursor);
    if (!candidate) return false;
    if (candidate.planId === planId) return true;
    cursor = candidate.planId;
  }

  throw new Error('Candidate scan did not terminate.');
}

test('different messages share one author dispatch lock', async () => {
  const f = await eligibleFixture('TIMEOUT');
  const next = await nextAuthorPlan(f);
  const bans = new BanExecutionStore(pool);
  const second = await bans.ensure(next.planId, next.channelId, next.sessionId);

  assert.notEqual(second.id, f.execution.id);

  const claims = await allResults([
    bans.claim(f.execution.id, randomUUID()),
    bans.claim(second.id, randomUUID()),
  ]);

  assert.equal(claims.filter(Boolean).length, 1);

  const winner = claims.find(Boolean);
  const blockedId = winner.execution.id === f.execution.id ? second.id : f.execution.id;

  assert.equal(
    await bans.complete(winner, {
      status: 'SUCCEEDED',
      http_status: 200,
      ban_id: 'confirmed-timeout',
    }),
    true,
  );

  // A successful timeout still blocks another dispatch while active.
  assert.equal(await bans.claim(blockedId, randomUUID()), null);
});

test('a new violation after an expired timeout can dispatch once', async () => {
  const f = await eligibleFixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);

  await seedHistoricalBanAttempt(f.execution.id);

  const next = await nextAuthorPlan(f);
  assert.equal(await findBanCandidate(next.planId), true);

  const second = await bans.ensure(next.planId, next.channelId, next.sessionId);
  assert.notEqual(second.id, f.execution.id);

  const claims = await allResults([
    bans.claim(second.id, randomUUID()),
    bans.claim(second.id, randomUUID()),
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await findBanCandidate(next.planId), false);
});

test('messages published during a past timeout do not become a later backlog', async () => {
  const f = await eligibleFixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);

  // Fixture timeout duration is 300 seconds; the boundary is 00:05:01.
  await seedHistoricalBanAttempt(f.execution.id);

  for (const publishedAt of ['2020-01-01T00:00:10Z', '2020-01-01T00:05:01Z']) {
    const old = await nextAuthorPlan(f, { publishedAt });
    const execution = await bans.ensure(old.planId, old.channelId, old.sessionId);

    assert.equal(await findBanCandidate(old.planId), false);
    assert.equal(await bans.claim(execution.id, randomUUID()), null);
  }

  const fresh = await nextAuthorPlan(f, {
    publishedAt: '2020-01-01T00:05:02Z',
  });

  assert.equal(await findBanCandidate(fresh.planId), true);

  const execution = await bans.ensure(fresh.planId, fresh.channelId, fresh.sessionId);

  assert.ok(await bans.claim(execution.id, randomUUID()));
});

test('unknown outcomes and confirmed permanent bans block new author actions', async () => {
  for (const [action, status] of [
    ['TIMEOUT', 'UNKNOWN'],
    ['BAN', 'SUCCEEDED'],
  ]) {
    const f = await eligibleFixture(action);
    const bans = new BanExecutionStore(pool);

    await seedHistoricalBanAttempt(f.execution.id, status);

    const next = await nextAuthorPlan(f);
    const execution = await bans.ensure(next.planId, next.channelId, next.sessionId);

    assert.equal(await findBanCandidate(next.planId), false);
    assert.equal(await bans.claim(execution.id, randomUUID()), null);
  }
});

test('an active action does not block a different channel session', async () => {
  const first = await eligibleFixture('TIMEOUT');
  const second = await eligibleFixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);

  assert.ok(await bans.claim(first.execution.id, randomUUID()));
  assert.ok(await bans.claim(second.execution.id, randomUUID()));
});

async function authorBlockReason(observationId) {
  const result = await pool.query(
    `
      SELECT ${BAN_DISPATCH_BLOCK_REASON_SQL} AS reason
      FROM youtube_chat_observations o
      WHERE o.id = $1
    `,
    [observationId],
  );

  assert.equal(result.rows.length, 1);
  return result.rows[0].reason;
}

test('author dispatch reasons distinguish unresolved and permanent outcomes', async () => {
  for (const [action, status, expected] of [
    ['TIMEOUT', 'UNKNOWN', 'PREVIOUS_OUTCOME_UNKNOWN'],
    ['BAN', 'SUCCEEDED', 'AUTHOR_ALREADY_BANNED'],
  ]) {
    const f = await eligibleFixture(action);
    await seedHistoricalBanAttempt(f.execution.id, status);

    const next = await nextAuthorPlan(f);

    assert.equal(await authorBlockReason(next.observationId), expected);
    assert.equal(await findBanCandidate(next.planId), false);
  }
});

test('an expired timeout still excludes old messages but permits newer messages', async () => {
  const f = await eligibleFixture('TIMEOUT');
  await seedHistoricalBanAttempt(f.execution.id);

  // Historical attempt finished at 00:00:01 with a 300-second duration.
  const old = await nextAuthorPlan(f, {
    publishedAt: '2020-01-01T00:05:01Z',
  });
  const fresh = await nextAuthorPlan(f, {
    publishedAt: '2020-01-01T00:05:02Z',
  });

  assert.equal(await authorBlockReason(old.observationId), 'MESSAGE_BEFORE_TIMEOUT_END');
  assert.equal(await authorBlockReason(fresh.observationId), null);
});

test('an in-progress author action has a distinct blocking reason', async () => {
  const f = await eligibleFixture('TIMEOUT');
  const next = await nextAuthorPlan(f);
  const bans = new BanExecutionStore(pool);

  assert.ok(await bans.claim(f.execution.id, randomUUID()));

  assert.equal(await authorBlockReason(next.observationId), 'AUTHOR_ACTION_IN_PROGRESS');
});

test('an active timeout window is distinguishable from an old message', async () => {
  const f = await eligibleFixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);
  const claim = await bans.claim(f.execution.id, randomUUID());

  assert.ok(claim);
  assert.equal(
    await bans.complete(claim, {
      status: 'SUCCEEDED',
      http_status: 200,
      ban_id: 'active-window-test',
    }),
    true,
  );

  // Simulate a provider timestamp ahead of the database clock.
  // Dispatch must still wait for the local scheduling window.
  const clock = await admin.query("SELECT clock_timestamp() + interval '1 hour' AS future");
  const next = await nextAuthorPlan(f, {
    publishedAt: clock.rows[0].future.toISOString(),
  });

  assert.equal(await authorBlockReason(next.observationId), 'TIMEOUT_WINDOW_ACTIVE');

  const execution = await bans.ensure(next.planId, next.channelId, next.sessionId);
  assert.equal(await bans.claim(execution.id, randomUUID()), null);
});

test('author dispatch reasons do not leak across sessions', async () => {
  const first = await eligibleFixture('BAN');
  await seedHistoricalBanAttempt(first.execution.id);

  const other = await eligibleFixture('TIMEOUT');

  assert.equal(await authorBlockReason(other.observationId), null);
});

test('concurrent ban claims persist one actor snapshot with worker permissions', async () => {
  const f = await fixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);
  const row = await bans.ensure(f.planId, f.channelId, f.sessionId);

  const actors = [
    {
      accountId: f.accountId,
      moderatorChannelId: `UC${'a'.repeat(22)}`,
    },
    {
      accountId: f.accountId,
      moderatorChannelId: `UC${'b'.repeat(22)}`,
    },
  ];

  const claims = await allResults(
    actors.map((actor) => bans.claim(row.id, randomUUID(), 30, actor)),
  );

  assert.equal(claims.filter(Boolean).length, 1);

  const winnerIndex = claims.findIndex(Boolean);
  const claim = claims[winnerIndex];

  const saved = await admin.query(
    `
      SELECT credential_account_id, moderator_channel_id, status
      FROM youtube_ban_attempts
      WHERE execution_id = $1
    `,
    [row.id],
  );

  assert.equal(saved.rows.length, 1);
  assert.deepEqual(saved.rows[0], {
    credential_account_id: actors[winnerIndex].accountId,
    moderator_channel_id: actors[winnerIndex].moderatorChannelId,
    status: 'DISPATCHED',
  });

  assert.equal(
    await bans.complete(claim, {
      status: 'SUCCEEDED',
      http_status: 200,
      ban_id: 'actor-snapshot-ban',
    }),
    true,
  );

  const completed = await admin.query(
    `
      SELECT credential_account_id, moderator_channel_id, status
      FROM youtube_ban_attempts
      WHERE id = $1
    `,
    [claim.attempt_id],
  );

  assert.deepEqual(completed.rows[0], {
    credential_account_id: actors[winnerIndex].accountId,
    moderator_channel_id: actors[winnerIndex].moderatorChannelId,
    status: 'SUCCEEDED',
  });

  assert.equal(await bans.claim(row.id, randomUUID(), 30, actors[1 - winnerIndex]), null);
});

test('ban claims reject credentials from another run without leaving an attempt', async () => {
  const f = await fixture('BAN');
  const other = await fixture('BAN');
  const bans = new BanExecutionStore(pool);
  const row = await bans.ensure(f.planId, f.channelId, f.sessionId);

  await assert.rejects(
    bans.claim(row.id, randomUUID(), 30, {
      accountId: other.accountId,
      moderatorChannelId: `UC${'a'.repeat(22)}`,
    }),
    { code: '23514' },
  );

  const attempts = await admin.query(
    'SELECT id FROM youtube_ban_attempts WHERE execution_id = $1',
    [row.id],
  );

  assert.equal(attempts.rows.length, 0);
  assert.equal((await eventsFor(row)).length, 0);

  const validClaim = await bans.claim(row.id, randomUUID(), 30, {
    accountId: f.accountId,
    moderatorChannelId: `UC${'a'.repeat(22)}`,
  });

  assert.ok(validClaim);
});

test('ban claims reject malformed actor channels before creating an attempt', async () => {
  const f = await fixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);
  const row = await bans.ensure(f.planId, f.channelId, f.sessionId);

  for (const moderatorChannelId of ['', 'invalid-channel', null, undefined]) {
    await assert.rejects(
      bans.claim(row.id, randomUUID(), 30, {
        accountId: f.accountId,
        moderatorChannelId,
      }),
      /valid YouTube moderator channel/,
    );
  }

  const attempts = await admin.query(
    'SELECT id FROM youtube_ban_attempts WHERE execution_id = $1',
    [row.id],
  );

  assert.equal(attempts.rows.length, 0);
});

test('legacy ban claims leave actor identity unknown', async () => {
  const f = await fixture('BAN');
  const bans = new BanExecutionStore(pool);
  const row = await bans.ensure(f.planId, f.channelId, f.sessionId);
  const claim = await bans.claim(row.id, randomUUID());

  assert.ok(claim);

  const result = await admin.query(
    `
      SELECT credential_account_id, moderator_channel_id
      FROM youtube_ban_attempts
      WHERE id = $1
    `,
    [claim.attempt_id],
  );

  assert.deepEqual(result.rows[0], {
    credential_account_id: null,
    moderator_channel_id: null,
  });
});

async function insertBanEvidenceObservation(
  f,
  claim,
  {
    moderatorChannelId = `UC${'a'.repeat(22)}`,
    targetChannelId = 'test-author',
    offsetSeconds = 1,
  } = {},
) {
  const observationId = randomUUID();
  const externalId = `event-${randomUUID()}`;

  const timestamp = await admin.query(
    `
      SELECT to_char(
        (started_at + $2 * interval '1 second') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS published_at
      FROM youtube_ban_attempts
      WHERE id = $1
    `,
    [claim.attempt_id, offsetSeconds],
  );

  const publishedAt = timestamp.rows[0].published_at;

  const payload = {
    id: externalId,
    snippet: {
      type: 'userBannedEvent',
      liveChatId: claim.execution.live_chat_id,
      authorChannelId: moderatorChannelId,
      publishedAt,
      userBannedDetails: {
        banType: 'temporary',
        banDurationSeconds: '300',
        bannedUserDetails: {
          channelId: targetChannelId,
        },
      },
    },
  };

  await admin.query(
    `
      INSERT INTO youtube_chat_observations(
        id,
        channel_id,
        session_id,
        first_observed_run_id,
        external_message_id,
        event_type,
        published_at,
        payload,
        payload_hash
      )
      VALUES(
        $1, $2, $3, $4, $5,
        'userBannedEvent', $6, $7::jsonb, $8
      )
    `,
    [
      observationId,
      f.channelId,
      f.sessionId,
      f.runId,
      externalId,
      publishedAt,
      JSON.stringify(payload),
      'b'.repeat(64),
    ],
  );

  return observationId;
}

test('evidence reader matches scoped events without changing UNKNOWN or publishing updates', async () => {
  const f = await fixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);
  const execution = await bans.ensure(f.planId, f.channelId, f.sessionId);

  const claim = await bans.claim(execution.id, randomUUID(), 30, {
    accountId: f.accountId,
    moderatorChannelId: `UC${'a'.repeat(22)}`,
  });

  assert.ok(claim);

  assert.equal(
    await bans.complete(claim, {
      status: 'UNKNOWN',
      http_status: null,
      code: 'TRANSPORT_ERROR',
    }),
    true,
  );

  const matchingId = await insertBanEvidenceObservation(f, claim);

  await insertBanEvidenceObservation(f, claim, {
    moderatorChannelId: `UC${'b'.repeat(22)}`,
  });

  await insertBanEvidenceObservation(f, claim, {
    targetChannelId: 'another-viewer',
  });

  await insertBanEvidenceObservation(f, claim, {
    offsetSeconds: -1,
  });

  await insertBanEvidenceObservation(f, claim, {
    offsetSeconds: 31,
  });

  const other = await fixture('TIMEOUT');

  // A matching payload in another session is not evidence for this attempt.
  await insertBanEvidenceObservation(other, claim);

  const reader = new BanEvidenceReader(pool);
  const eventsBefore = await eventsFor(execution);

  const matches = [];
  let cursor = null;
  let pages = 0;

  do {
    const page = await reader.read(claim.attempt_id, cursor, 1);

    assert.ok(page);
    matches.push(...page.matches);
    cursor = page.nextCursor;
    pages += 1;

    assert.ok(pages <= 10, 'Evidence pagination must make progress.');
  } while (cursor !== null);

  assert.equal(pages, 3);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].observationId, matchingId);
  assert.equal(matches[0].attribution, 'UNPROVEN');

  const stored = await admin.query('SELECT status FROM youtube_ban_attempts WHERE id = $1', [
    claim.attempt_id,
  ]);

  assert.equal(stored.rows[0].status, 'UNKNOWN');
  assert.deepEqual(await eventsFor(execution), eventsBefore);

  const replay = await reader.read(claim.attempt_id);
  assert.deepEqual(replay.matches, matches);
});

test('evidence reader excludes unknown attempts without recorded actors', async () => {
  const f = await fixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);
  const execution = await bans.ensure(f.planId, f.channelId, f.sessionId);
  const claim = await bans.claim(execution.id, randomUUID());

  await bans.complete(claim, {
    status: 'UNKNOWN',
    http_status: null,
    code: 'TRANSPORT_ERROR',
  });

  const reader = new BanEvidenceReader(pool);

  assert.equal(await reader.read(claim.attempt_id), null);
  assert.equal(await reader.read(randomUUID()), null);
});

test('evidence reader excludes confirmed attempts even when actors are recorded', async () => {
  const f = await fixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);
  const execution = await bans.ensure(f.planId, f.channelId, f.sessionId);

  const claim = await bans.claim(execution.id, randomUUID(), 30, {
    accountId: f.accountId,
    moderatorChannelId: `UC${'a'.repeat(22)}`,
  });

  await bans.complete(claim, {
    status: 'SUCCEEDED',
    http_status: 200,
    ban_id: 'confirmed-evidence-test',
  });

  const reader = new BanEvidenceReader(pool);

  assert.equal(await reader.read(claim.attempt_id), null);
});

test('evidence reader validates page size and identifiers', async () => {
  const reader = new BanEvidenceReader(pool);

  for (const limit of [0, -1, 101, 1.5]) {
    await assert.rejects(reader.read(randomUUID(), null, limit), /page size/);
  }

  await assert.rejects(reader.read('invalid-id'));
  await assert.rejects(reader.nextAttempt('invalid-id'));
});

async function unknownEvidenceFixture() {
  const f = await fixture('TIMEOUT');
  const bans = new BanExecutionStore(pool);
  const execution = await bans.ensure(f.planId, f.channelId, f.sessionId);

  const claim = await bans.claim(execution.id, randomUUID(), 30, {
    accountId: f.accountId,
    moderatorChannelId: `UC${'a'.repeat(22)}`,
  });

  assert.ok(claim);

  assert.equal(
    await bans.complete(claim, {
      status: 'UNKNOWN',
      http_status: null,
      code: 'TRANSPORT_ERROR',
    }),
    true,
  );

  return { f, execution, claim };
}

test('evidence storage is idempotent across concurrent workers and restarts', async () => {
  const { f, execution, claim } = await unknownEvidenceFixture();
  const observationId = await insertBanEvidenceObservation(f, claim);
  const eventsBefore = await eventsFor(execution);

  const results = await allResults([
    new BanEvidenceStore(pool).save(claim.attempt_id, observationId),
    new BanEvidenceStore(pool).save(claim.attempt_id, observationId),
  ]);

  assert.deepEqual(results.sort(), ['EXISTING', 'INSERTED']);

  assert.equal(await new BanEvidenceStore(pool).save(claim.attempt_id, observationId), 'EXISTING');

  const saved = await admin.query(
    `
      SELECT attempt_id, observation_id, attribution
      FROM youtube_ban_evidence
      WHERE attempt_id = $1
    `,
    [claim.attempt_id],
  );

  assert.deepEqual(saved.rows, [
    {
      attempt_id: claim.attempt_id,
      observation_id: observationId,
      attribution: 'UNPROVEN',
    },
  ]);

  const attempt = await admin.query('SELECT status FROM youtube_ban_attempts WHERE id = $1', [
    claim.attempt_id,
  ]);

  assert.equal(attempt.rows[0].status, 'UNKNOWN');
  const eventsAfter = await eventsFor(execution);

  assert.deepEqual(eventsAfter.slice(0, eventsBefore.length), eventsBefore);
  assert.equal(eventsAfter.length, eventsBefore.length + 1);
  assert.equal(eventsAfter.at(-1).event_type, 'chat.updated');
  assert.equal(eventsAfter.at(-1).run_id, f.runId);
});

test('evidence storage rejects mismatched events and cross-session references', async () => {
  const { f, claim } = await unknownEvidenceFixture();
  const evidenceStore = new BanEvidenceStore(pool);
  const other = await fixture('TIMEOUT');

  const invalidIds = [
    await insertBanEvidenceObservation(f, claim, {
      moderatorChannelId: `UC${'b'.repeat(22)}`,
    }),
    await insertBanEvidenceObservation(f, claim, {
      targetChannelId: 'another-viewer',
    }),
    await insertBanEvidenceObservation(f, claim, {
      offsetSeconds: -1,
    }),
    await insertBanEvidenceObservation(f, claim, {
      offsetSeconds: 31,
    }),
    await insertBanEvidenceObservation(other, claim),
  ];

  for (const observationId of invalidIds) {
    assert.equal(await evidenceStore.save(claim.attempt_id, observationId), 'NOT_MATCHED');

    // Database validation also rejects bypassing the store.
    await assert.rejects(
      pool.query(
        `
          INSERT INTO youtube_ban_evidence(attempt_id, observation_id)
          VALUES($1, $2)
        `,
        [claim.attempt_id, observationId],
      ),
      { code: '23514' },
    );
  }

  const saved = await admin.query(
    'SELECT attempt_id FROM youtube_ban_evidence WHERE attempt_id = $1',
    [claim.attempt_id],
  );

  assert.equal(saved.rows.length, 0);
});

test('worker evidence permissions allow insertion but forbid changes and deletion', async () => {
  const { f, claim } = await unknownEvidenceFixture();
  const observationId = await insertBanEvidenceObservation(f, claim);

  assert.equal(await new BanEvidenceStore(pool).save(claim.attempt_id, observationId), 'INSERTED');

  await assert.rejects(
    pool.query(
      `
        UPDATE youtube_ban_evidence
        SET attribution = 'UNPROVEN'
        WHERE attempt_id = $1
      `,
      [claim.attempt_id],
    ),
    { code: '42501' },
  );

  await assert.rejects(
    pool.query('DELETE FROM youtube_ban_evidence WHERE attempt_id = $1', [claim.attempt_id]),
    { code: '42501' },
  );

  await assert.rejects(
    admin.query(
      `
        UPDATE youtube_ban_evidence
        SET attribution = 'UNPROVEN'
        WHERE attempt_id = $1
      `,
      [claim.attempt_id],
    ),
  );
});

test('evidence publication failure rolls back the evidence link', async () => {
  const { f, execution, claim } = await unknownEvidenceFixture();
  const observationId = await insertBanEvidenceObservation(f, claim);
  const evidenceStore = new BanEvidenceStore(pool);
  const eventsBefore = await eventsFor(execution);

  await admin.query(`REVOKE INSERT ON ${schema}.live_events FROM ${role}`);

  try {
    await assert.rejects(evidenceStore.save(claim.attempt_id, observationId), { code: '42501' });
  } finally {
    await admin.query(`GRANT INSERT ON ${schema}.live_events TO ${role}`);
  }

  const links = await admin.query(
    `
      SELECT observation_id
      FROM youtube_ban_evidence
      WHERE attempt_id = $1
    `,
    [claim.attempt_id],
  );

  assert.equal(links.rows.length, 0);
  assert.deepEqual(await eventsFor(execution), eventsBefore);

  assert.equal(await evidenceStore.save(claim.attempt_id, observationId), 'INSERTED');

  assert.equal((await eventsFor(execution)).length, eventsBefore.length + 1);
});

test('integration: late evidence is collected after rescan and restart does not duplicate publication', async () => {
  const { f, execution, claim } = await unknownEvidenceFixture();
  const baselineEvents = await eventsFor(execution);
  const signal = new AbortController().signal;
  let now = 0;

  function createScanner() {
    const reader = new BanEvidenceReader(pool);
    let exhausted = false;

    const coordinator = new BanEvidenceCoordinator(
      {
        async nextAttempt(after) {
          const candidate = await reader.nextAttempt(after);

          if (candidate === null) {
            exhausted = true;
          }

          return candidate;
        },
        read: reader.read.bind(reader),
      },
      new BanEvidenceStore(pool),
      () => now,
    );

    return {
      coordinator,
      async drain() {
        exhausted = false;

        for (let index = 0; index < 1000; index += 1) {
          await coordinator.tick(signal);

          if (exhausted) return;
        }

        assert.fail('Evidence scan did not reach the end.');
      },
    };
  }

  async function storedEvidence() {
    const result = await admin.query(
      `
        SELECT observation_id, attribution
        FROM youtube_ban_evidence
        WHERE attempt_id = $1
        ORDER BY observation_id
      `,
      [claim.attempt_id],
    );

    return result.rows;
  }

  const scanner = createScanner();

  // Complete a scan before the provider event has been ingested.
  await scanner.drain();

  assert.deepEqual(await storedEvidence(), []);
  assert.deepEqual(await eventsFor(execution), baselineEvents);

  // The event is persisted late, but its publication time matches the attempt.
  const observationId = await insertBanEvidenceObservation(f, claim);

  now = 29_999;
  await scanner.coordinator.tick(signal);

  assert.deepEqual(await storedEvidence(), []);
  assert.deepEqual(await eventsFor(execution), baselineEvents);

  now = 30_000;
  await scanner.drain();

  assert.deepEqual(await storedEvidence(), [
    {
      observation_id: observationId,
      attribution: 'UNPROVEN',
    },
  ]);

  const afterCollection = await eventsFor(execution);

  assert.equal(afterCollection.length, baselineEvents.length + 1);
  assert.deepEqual(afterCollection.slice(0, baselineEvents.length), baselineEvents);
  assert.equal(afterCollection.at(-1).event_type, 'chat.updated');
  assert.equal(afterCollection.at(-1).run_id, f.runId);

  // A fresh coordinator has no in-memory cursors, as after a worker restart.
  const restarted = createScanner();
  await restarted.drain();

  assert.deepEqual(await storedEvidence(), [
    {
      observation_id: observationId,
      attribution: 'UNPROVEN',
    },
  ]);
  assert.deepEqual(await eventsFor(execution), afterCollection);

  const attempts = await admin.query(
    `
      SELECT id, status, error_code
      FROM youtube_ban_attempts
      WHERE execution_id = $1
    `,
    [execution.id],
  );

  assert.deepEqual(attempts.rows, [
    {
      id: claim.attempt_id,
      status: 'UNKNOWN',
      error_code: 'TRANSPORT_ERROR',
    },
  ]);

  // Evidence collection must not make the original execution dispatchable.
  assert.equal(await new BanExecutionStore(pool).claim(execution.id, randomUUID()), null);
});
