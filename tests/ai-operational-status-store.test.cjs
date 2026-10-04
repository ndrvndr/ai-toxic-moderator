const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');
const { AiOperationalStatusStore } = source(
  'apps/worker/src/ingestion/ai-operational-status-store.ts',
);
const { aiOperationalStatus } = source('packages/contracts/src/index.ts');

const schema = `ai_status_${randomUUID().replaceAll('-', '')}`;
const workerRole = `ai_status_worker_${randomUUID().replaceAll('-', '')}`;
const apiRole = `ai_status_api_${randomUUID().replaceAll('-', '')}`;
let admin, worker, api;
let schemaCreated = false,
  workerCreated = false,
  apiCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Set TEST_DATABASE_URL to an admin-capable local test database.');
  const { migrate } = await import('../scripts/database.mjs');
  const { provisionWorkerRole } = await import('../scripts/worker-role.mjs');
  const { provisionRuntimeRole } = await import('../scripts/runtime-role.mjs');
  admin = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await admin.query(`SET search_path TO ${schema}`);
  await migrate(admin);
  await migrate(admin);
  await provisionWorkerRole(admin, { role: workerRole, password: randomUUID(), schema });
  workerCreated = true;
  await provisionRuntimeRole(admin, { role: apiRole, password: randomUUID(), schema });
  apiCreated = true;
  worker = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${workerRole}`,
    max: 4,
    statement_timeout: 10000,
    connectionTimeoutMillis: 3000,
  });
  api = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${apiRole}`,
    max: 2,
    statement_timeout: 10000,
    connectionTimeoutMillis: 3000,
  });
});

after(async () => {
  await Promise.all([worker?.end(), api?.end()]);
  if (admin) {
    try {
      if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      if (workerCreated) await admin.query(`DROP ROLE ${workerRole}`);
      if (apiCreated) await admin.query(`DROP ROLE ${apiRole}`);
    } finally {
      await admin.end();
    }
  }
});

async function fixture() {
  const f = {
    account: randomUUID(),
    channel: randomUUID(),
    session: randomUUID(),
    run: randomUUID(),
  };
  await admin.query("INSERT INTO accounts(id,display_name) VALUES($1,'AI status owner')", [
    f.account,
  ]);
  await admin.query("INSERT INTO channels(id,display_name) VALUES($1,'AI status fixture')", [
    f.channel,
  ]);
  await admin.query('INSERT INTO youtube_channels(channel_id,youtube_channel_id) VALUES($1,$2)', [
    f.channel,
    randomUUID(),
  ]);
  await admin.query(
    "INSERT INTO stream_sessions(id,channel_id,label,source) VALUES($1,$2,'AI status fixture','YOUTUBE')",
    [f.session, f.channel],
  );
  await admin.query(
    'INSERT INTO youtube_broadcasts(session_id,channel_id,youtube_broadcast_id,live_chat_id) VALUES($1,$2,$3,$4)',
    [f.session, f.channel, randomUUID(), randomUUID()],
  );
  await admin.query(
    'INSERT INTO monitoring_runs(id,channel_id,session_id,requested_by_account_id,credential_account_id) VALUES($1,$2,$3,$4,$4)',
    [f.run, f.channel, f.session, f.account],
  );
  return f;
}

const waiting = (f) => ({
  channel_id: f.channel,
  session_id: null,
  run_id: null,
  status: 'WAITING',
  reason: 'NO_ELIGIBLE_RUN',
  error_code: null,
});
const active = (f) => ({
  channel_id: f.channel,
  session_id: f.session,
  run_id: f.run,
  status: 'ACTIVE',
  reason: 'RUN_SELECTED',
  error_code: null,
});
async function row(channel) {
  return (await admin.query('SELECT * FROM ai_operational_status WHERE channel_id=$1', [channel]))
    .rows[0];
}
async function expire(channel) {
  // Simulate elapsed time only in this suite's isolated schema, without a 30s sleep.
  await admin.query('BEGIN');
  try {
    await admin.query(
      'ALTER TABLE ai_operational_status DISABLE TRIGGER ai_operational_status_stamp',
    );
    await admin.query(
      `WITH moment AS MATERIALIZED (SELECT clock_timestamp()-interval '31 seconds' AS at)
      UPDATE ai_operational_status SET updated_at=LEAST(updated_at,moment.at),
      heartbeat_at=moment.at,expires_at=moment.at+interval '30 seconds'
      FROM moment WHERE channel_id=$1`,
      [channel],
    );
    await admin.query(
      'ALTER TABLE ai_operational_status ENABLE TRIGGER ai_operational_status_stamp',
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

test('worker claims and publishes state with database timestamps and no live events', async () => {
  const f = await fixture(),
    store = new AiOperationalStatusStore(worker);
  const lease = await store.claim(f.channel);
  assert.equal(lease.generation, '1');
  const initial = await row(f.channel);
  assert.equal(initial.status, 'WAITING');
  assert.equal(initial.updated_at.getTime(), initial.heartbeat_at.getTime());
  const report = await store.publish(lease, active(f));
  assert.equal(report.status, 'ACTIVE');
  assert.deepEqual(aiOperationalStatus.parse(report), report);
  const saved = await row(f.channel);
  assert.equal(saved.updated_at.getTime(), saved.heartbeat_at.getTime());
  assert.equal(saved.expires_at.getTime() - saved.heartbeat_at.getTime(), 30_000);
  assert.equal(
    (
      await admin.query('SELECT count(*)::int AS n FROM live_events WHERE channel_id=$1', [
        f.channel,
      ])
    ).rows[0].n,
    0,
  );
});

test('unchanged state renews heartbeat while a scope/reason/error change advances updated_at', async () => {
  const f = await fixture(),
    store = new AiOperationalStatusStore(worker),
    lease = await store.claim(f.channel);
  await store.publish(lease, active(f));
  const first = await row(f.channel);
  await store.publish(lease, active(f));
  const same = await row(f.channel);
  assert.equal(same.updated_at.toISOString(), first.updated_at.toISOString());
  assert.ok(same.heartbeat_at >= first.heartbeat_at);
  await store.publish(lease, {
    ...active(f),
    status: 'ERROR',
    reason: 'PROCESSING_FAILED',
    error_code: 'INFERENCE_TIMEOUT',
  });
  const changed = await row(f.channel);
  assert.equal(changed.error_code, 'INFERENCE_TIMEOUT');
  assert.equal(changed.updated_at.getTime(), changed.heartbeat_at.getTime());
  assert.ok(changed.updated_at >= same.heartbeat_at);
  await store.publish(lease, waiting(f));
  assert.equal((await row(f.channel)).run_id, null);
});

test('competing claims select one owner and concurrent heartbeats cannot change generation', async () => {
  const f = await fixture(),
    a = new AiOperationalStatusStore(worker),
    b = new AiOperationalStatusStore(worker);
  const claims = await Promise.all([a.claim(f.channel), b.claim(f.channel)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const winner = claims[0] ? a : b,
    lease = claims.find(Boolean);
  const reports = await Promise.all([
    winner.publish(lease, active(f)),
    winner.publish(lease, active(f)),
  ]);
  assert.ok(reports.every((r) => r.status === 'ACTIVE'));
  assert.equal((await row(f.channel)).generation, '1');
  assert.equal(await winner.claim(f.channel), null);
});

test('expiry fences the old token and restart takeover resets scope with a new generation', async () => {
  const f = await fixture(),
    old = new AiOperationalStatusStore(worker),
    lease = await old.claim(f.channel);
  await old.publish(lease, active(f));
  await expire(f.channel);
  assert.equal(await old.publish(lease, active(f)), null);
  const replacement = new AiOperationalStatusStore(worker),
    next = await replacement.claim(f.channel);
  assert.equal(next.generation, '2');
  assert.equal((await row(f.channel)).status, 'WAITING');
  assert.equal((await row(f.channel)).run_id, null);
  assert.equal(await old.publish(lease, active(f)), null);
  await replacement.publish(next, active(f));
  await expire(f.channel);
  const reused = new AiOperationalStatusStore(worker, next.owner_id),
    third = await reused.claim(f.channel);
  assert.equal(third.generation, '3');
  assert.equal(await reused.publish(next, active(f)), null);
  assert.equal((await reused.publish(third, active(f))).status, 'ACTIVE');
});

test('foreign channel/run and session substitutions are rejected atomically', async () => {
  const f = await fixture(),
    foreign = await fixture(),
    store = new AiOperationalStatusStore(worker),
    lease = await store.claim(f.channel);
  await assert.rejects(store.publish(lease, active(foreign)), /scope mismatch/);
  for (const change of [
    { session_id: foreign.session, run_id: foreign.run },
    { session_id: foreign.session, run_id: f.run },
    { session_id: f.session, run_id: foreign.run },
  ])
    await assert.rejects(store.publish(lease, { ...active(f), ...change }), { code: '23503' });
  assert.equal((await row(f.channel)).status, 'WAITING');
});

test('database also rejects invalid public combinations and partial scope without store validation', async () => {
  const f = await fixture(),
    store = new AiOperationalStatusStore(worker);
  await store.claim(f.channel);
  for (const [sql, values] of [
    [
      "UPDATE ai_operational_status SET status='ERROR',reason='PROCESSING_FAILED',error_code=NULL WHERE channel_id=$1",
      [f.channel],
    ],
    [
      "UPDATE ai_operational_status SET status='ACTIVE',reason='RUN_SELECTED' WHERE channel_id=$1",
      [f.channel],
    ],
    ['UPDATE ai_operational_status SET session_id=$2 WHERE channel_id=$1', [f.channel, f.session]],
    [
      "UPDATE ai_operational_status SET status='ERROR',reason='PROCESSING_FAILED',error_code='private raw error' WHERE channel_id=$1",
      [f.channel],
    ],
    [
      "UPDATE ai_operational_status SET reason='RUN_AI_DISABLED',status='DISABLED' WHERE channel_id=$1",
      [f.channel],
    ],
  ])
    await assert.rejects(worker.query(sql, values), { code: '23514' });
  assert.equal((await row(f.channel)).status, 'WAITING');
});

test('database owns clock fields and prevents live-owner replacement or channel reassignment', async () => {
  const f = await fixture(),
    foreign = await fixture(),
    owner = randomUUID();
  await worker.query(
    `INSERT INTO ai_operational_status
    (channel_id,owner_id,generation,status,reason,updated_at,heartbeat_at,expires_at)
    VALUES($1,$2,99,'WAITING','NO_ELIGIBLE_RUN','9999-01-01','9999-01-01','9999-01-01')`,
    [f.channel, owner],
  );
  const before = await row(f.channel);
  assert.equal(before.generation, '1');
  assert.ok(before.heartbeat_at.getFullYear() < 9999);
  await worker.query(
    "UPDATE ai_operational_status SET heartbeat_at='9999-01-01',updated_at='9999-01-01',expires_at='9999-01-01' WHERE channel_id=$1",
    [f.channel],
  );
  assert.equal((await row(f.channel)).updated_at.toISOString(), before.updated_at.toISOString());
  await assert.rejects(
    worker.query(
      'UPDATE ai_operational_status SET owner_id=$2,generation=generation+1 WHERE channel_id=$1',
      [f.channel, randomUUID()],
    ),
    { code: '23514' },
  );
  await assert.rejects(
    worker.query('UPDATE ai_operational_status SET channel_id=$2 WHERE channel_id=$1', [
      f.channel,
      foreign.channel,
    ]),
    { code: '23514' },
  );
});

test('API role can read reports but cannot insert, update or delete; worker cannot delete', async () => {
  const f = await fixture(),
    store = new AiOperationalStatusStore(worker);
  await store.claim(f.channel);
  assert.equal(
    (await api.query('SELECT status FROM ai_operational_status WHERE channel_id=$1', [f.channel]))
      .rows[0].status,
    'WAITING',
  );
  for (const query of [
    "UPDATE ai_operational_status SET status='WAITING' WHERE channel_id=$1",
    'DELETE FROM ai_operational_status WHERE channel_id=$1',
    "INSERT INTO ai_operational_status(channel_id,owner_id,generation,status,reason) VALUES($1,$1,1,'WAITING','NO_ELIGIBLE_RUN')",
  ])
    await assert.rejects(api.query(query, [f.channel]), { code: '42501' });
  await assert.rejects(
    worker.query('DELETE FROM ai_operational_status WHERE channel_id=$1', [f.channel]),
    { code: '42501' },
  );
});

test('invalid client state and ownership fail before database access', async () => {
  const owner = randomUUID(),
    channel = randomUUID();
  const store = new AiOperationalStatusStore(
    {
      query() {
        throw new Error('Unexpected database access');
      },
    },
    owner,
  );
  const lease = { channel_id: channel, owner_id: owner, generation: '1' };
  const update = {
    channel_id: channel,
    session_id: null,
    run_id: null,
    status: 'WAITING',
    reason: 'NO_ELIGIBLE_RUN',
    error_code: null,
  };
  await assert.rejects(
    store.publish({ ...lease, owner_id: randomUUID() }, update),
    /Invalid AI status lease/,
  );
  await assert.rejects(
    store.publish({ ...lease, generation: '0' }, update),
    /Invalid AI status lease/,
  );
  await assert.rejects(
    store.publish(lease, { ...update, raw_error: 'private' }),
    /Invalid AI status update fields/,
  );
  await assert.rejects(
    store.publish(lease, { ...update, updated_at: '9999-01-01' }),
    /Invalid AI status update fields/,
  );
  await assert.rejects(store.publish(lease, { ...update, status: 'ACTIVE' }));
});
