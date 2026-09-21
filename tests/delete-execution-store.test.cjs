const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');

const { DeleteExecutionStore } = source('apps/worker/src/ingestion/delete-execution-store.ts');
const { DeleteEligibilityStore } = source('apps/worker/src/ingestion/delete-eligibility-store.ts');
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

async function fixture(action = 'DELETE') {
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
     VALUES($1, $2, $3, $4, $5, 'textMessageEvent', clock_timestamp(), '{}'::jsonb, $6)`,
    [f.observationId, f.channelId, f.sessionId, f.runId, f.externalMessageId, 'a'.repeat(64)],
  );
  await admin.query(
    `INSERT INTO youtube_chat_classifications(id, channel_id, session_id, observation_id, run_id,
      classifier_version, policy_version, outcome, primary_category, severity, reason_code, reason, signals)
     VALUES($1, $2, $3, $4, $5, 'test-rules-1', 'test-policy-1', 'REVIEW', 'HARASSMENT',
      2, 'DIRECT_INSULT', 'Deletion store fixture.', '[]'::jsonb)`,
    [f.classificationId, f.channelId, f.sessionId, f.observationId, f.runId],
  );
  await insertPlan(f, f.planId, 'test-actions-1', action);
  return f;
}

async function insertPlan(f, id, version, action = 'DELETE') {
  await admin.query(
    `INSERT INTO youtube_moderation_action_plans(id, channel_id, session_id, classification_id,
      policy_version, action, reason) VALUES($1, $2, $3, $4, $5, $6, 'Deletion store fixture.')`,
    [id, f.channelId, f.sessionId, f.classificationId, version, action],
  );
}

async function execution(f) {
  return store.ensure(f.planId, f.channelId, f.sessionId);
}

async function allResults(promises) {
  const settled = await Promise.allSettled(promises);
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

async function eligibleFixture() {
  const f = await fixture();
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
  return { ...f, execution: await execution(f) };
}

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
  const row = await execution(await fixture());
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
});
