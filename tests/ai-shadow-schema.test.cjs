const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Client } = require('pg');

const schema = `ai_shadow_${randomUUID().replaceAll('-', '')}`;

let client;
let migrate;
let schemaCreated = false;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error('Set TEST_DATABASE_URL to a local test database.');
  }

  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Classification schema tests require a local database.');
  }

  ({ migrate } = await import('../scripts/database.mjs'));

  client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await client.query(`SET search_path TO ${schema}`);
  await migrate(client);
});

after(async () => {
  if (!client) return;

  try {
    if (schemaCreated) {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  } finally {
    await client.end();
  }
});

async function fixture() {
  const accountId = randomUUID();
  const channelId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();

  await client.query('INSERT INTO accounts(id, display_name) VALUES($1, $2)', [
    accountId,
    'Classification test account',
  ]);

  await client.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
    channelId,
    'Classification test channel',
  ]);

  await client.query(
    `
      INSERT INTO youtube_channels(channel_id, youtube_channel_id)
      VALUES($1, $2)
    `,
    [channelId, `channel-${randomUUID()}`],
  );

  await client.query(
    `
      INSERT INTO stream_sessions(id, channel_id, label, source)
      VALUES($1, $2, 'Classification test session', 'YOUTUBE')
    `,
    [sessionId, channelId],
  );

  await client.query(
    `
      INSERT INTO youtube_broadcasts(
        session_id,
        channel_id,
        youtube_broadcast_id,
        live_chat_id
      )
      VALUES($1, $2, $3, $4)
    `,
    [sessionId, channelId, `broadcast-${randomUUID()}`, `chat-${randomUUID()}`],
  );

  await client.query(
    `
      INSERT INTO monitoring_runs(
        id,
        channel_id,
        session_id,
        requested_by_account_id,
        credential_account_id
      )
      VALUES($1, $2, $3, $4, $4)
    `,
    [runId, channelId, sessionId, accountId],
  );

  return {
    accountId,
    channelId,
    sessionId,
    runId,
  };
}

async function insertObservation(f, id = randomUUID()) {
  const payload = {
    authorDetails: { channelId: 'test-viewer-channel' },
    snippet: {
      type: 'textMessageEvent',
      liveChatId: 'test-live-chat',
      publishedAt: '2026-09-20T00:00:00Z',
    },
    text: 'Test classification message',
  };

  const serialized = JSON.stringify(payload);
  const payloadHash = createHash('sha256').update(serialized).digest('hex');

  await client.query(
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
        $1,
        $2,
        $3,
        $4,
        $5,
        'textMessageEvent',
        clock_timestamp(),
        $6::jsonb,
        $7
      )
    `,
    [id, f.channelId, f.sessionId, f.runId, `message-${id}`, serialized, payloadHash],
  );

  return id;
}

async function insertShadow(f, observationId, overrides = {}) {
  const row = {
    id: randomUUID(),
    channelId: f.channelId,
    sessionId: f.sessionId,
    runId: f.runId,
    observationId,
    modelId: 'laskar-ks/toxic-guardrail-minilm-id-en',
    revision: 'a'.repeat(40),
    variant: 'INT8',
    adapterVersion: 'laskar-1',
    status: 'SUCCEEDED',
    rating: 2,
    score: 0.56,
    truncated: false,
    latency: 5,
    error: null,
    ...overrides,
  };
  await client.query(
    `INSERT INTO youtube_ai_shadow_results (
      id, channel_id, session_id, observation_id, run_id, model_id, model_revision,
      model_variant, adapter_version, status, rating, severity_score, truncated, inference_ms, error_code
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      row.id,
      row.channelId,
      row.sessionId,
      row.observationId,
      row.runId,
      row.modelId,
      row.revision,
      row.variant,
      row.adapterVersion,
      row.status,
      row.rating,
      row.score,
      row.truncated,
      row.latency,
      row.error,
    ],
  );
  return row.id;
}

test('shadow migration is repeatable', async () => {
  await migrate(client);
  const result = await client.query('SELECT name FROM schema_migrations WHERE name=$1', [
    '020_youtube_ai_shadow_results.sql',
  ]);
  assert.equal(result.rowCount, 1);
});

test('shadow result is independent of classifications and action plans', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  await insertShadow(f, observationId);
  for (const table of ['youtube_chat_classifications', 'youtube_moderation_action_plans']) {
    const rows = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
    assert.equal(rows.rows[0].count, 0);
  }
});

test('duplicate output is rejected but another model revision is preserved', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  await insertShadow(f, observationId);
  await assert.rejects(insertShadow(f, observationId), { code: '23505' });
  await insertShadow(f, observationId, { revision: 'b'.repeat(40) });
});

test('cross-session observations and runs are rejected', async () => {
  const first = await fixture();
  const second = await fixture();
  const observationId = await insertObservation(first);
  await assert.rejects(insertShadow(second, observationId), { code: '23503' });
  await assert.rejects(insertShadow(first, observationId, { runId: second.runId }), {
    code: '23503',
  });
});

test('a later run cannot replace the observation original run', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  await client.query(
    `UPDATE monitoring_runs SET status='STOPPED', finished_at=clock_timestamp() WHERE id=$1`,
    [f.runId],
  );
  const anotherRun = randomUUID();
  await client.query(
    `INSERT INTO monitoring_runs(id,channel_id,session_id,requested_by_account_id,credential_account_id)
     VALUES($1,$2,$3,$4,$4)`,
    [anotherRun, f.channelId, f.sessionId, f.accountId],
  );
  await assert.rejects(insertShadow(f, observationId, { runId: anotherRun }), { code: '23503' });
});

test('database rejects invalid success and failure payloads', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  for (const overrides of [
    { rating: 1 },
    { rating: null },
    { score: 1.1 },
    { score: NaN },
    { latency: -1 },
    { revision: 'main' },
    { truncated: null },
    { error: 'INFERENCE_FAILED' },
    { status: 'ERROR' },
    { status: 'ERROR', rating: null, score: null, truncated: null, latency: null, error: null },
  ])
    await assert.rejects(insertShadow(f, observationId, overrides), { code: '23514' });
  await insertShadow(f, observationId, {
    status: 'ERROR',
    rating: null,
    score: null,
    truncated: null,
    latency: null,
    error: 'INFERENCE_TIMEOUT',
  });
});

test('historical shadow output cannot be updated', async () => {
  const f = await fixture();
  const observationId = await insertObservation(f);
  const id = await insertShadow(f, observationId);
  await assert.rejects(
    client.query('UPDATE youtube_ai_shadow_results SET rating=0 WHERE id=$1', [id]),
  );
  const result = await client.query('SELECT rating FROM youtube_ai_shadow_results WHERE id=$1', [
    id,
  ]);
  assert.equal(result.rows[0].rating, 2);
});

test('worker can insert and read shadow rows while API has read-only access', async () => {
  const { provisionWorkerRole } = await import('../scripts/worker-role.mjs');
  const { provisionRuntimeRole } = await import('../scripts/runtime-role.mjs');
  const roles = [];
  try {
    for (const [kind, provision] of [
      ['worker', provisionWorkerRole],
      ['api', provisionRuntimeRole],
    ]) {
      const role = `ai_${kind}_${randomUUID().replaceAll('-', '')}`;
      // Track before provisioning so partial failures can be cleaned up.
      roles.push(role);
      await provision(client, { role, password: 'local-ai-shadow-test-only', schema });
      const result = await client.query(
        `SELECT has_table_privilege($1,$2,'SELECT') AS "read",
          has_table_privilege($1,$2,'INSERT') AS "insert",
          has_table_privilege($1,$2,'UPDATE') AS "update",
          has_table_privilege($1,$2,'DELETE') AS "delete"`,
        [role, `${schema}.youtube_ai_shadow_results`],
      );
      assert.deepEqual(result.rows[0], {
        read: true,
        insert: kind === 'worker',
        update: false,
        delete: false,
      });
    }
  } finally {
    for (const role of roles) {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
      if (!exists.rowCount) continue;
      await client.query(`DROP OWNED BY "${role}"`);
      await client.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  }
});
