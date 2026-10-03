const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Client } = require('pg');
const { Pool } = require('pg');
const { source } = require('./helpers/source.cjs');
const { AiShadowStore } = source('apps/worker/src/ingestion/ai-shadow-store.ts');

const schema = `ai_shadow_${randomUUID().replaceAll('-', '')}`;

let client;
let migrate;
let schemaCreated = false;

test('competing worker transactions reuse one persisted shadow result and rollback is atomic', async () => {
  const { provisionWorkerRole } = await import('../scripts/worker-role.mjs');
  const role = `ai_store_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 2,
    options: `-c search_path=${schema}`,
    statement_timeout: 5000,
  });
  let provisioned = false;
  try {
    await provisionWorkerRole(client, { role, password: 'local-shadow-store-test-only', schema });
    provisioned = true;
    const f = await fixture();
    const observationId = await insertObservation(f);
    const input = {
      channel_id: f.channelId,
      session_id: f.sessionId,
      observation_id: observationId,
      run_id: f.runId,
      model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
      model_revision: 'a'.repeat(40),
      model_variant: 'INT8',
      adapter_version: 'store-test-1',
      status: 'SUCCEEDED',
      rating: 2,
      severity_score: 0.56,
      truncated: false,
      inference_ms: 5,
      error_code: null,
    };
    const store = new AiShadowStore();
    async function saveTransaction(value, rollback = false) {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(`SET LOCAL ROLE "${role}"`);
        const result = await store.save(connection, value);
        await connection.query(rollback ? 'ROLLBACK' : 'COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }
    // Each transaction commits independently so the losing INSERT can observe its winner.
    const settled = await Promise.allSettled([
      saveTransaction(input),
      saveTransaction({ ...input, rating: 0, severity_score: 0.1 }),
    ]);
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    const results = settled.map((entry) => entry.value);
    assert.equal(results.filter((entry) => entry.inserted).length, 1);
    assert.equal(results[0].id, results[1].id);
    assert.deepEqual(results[0].result, results[1].result);
    const count = await client.query(
      'SELECT count(*)::int AS count FROM youtube_ai_shadow_results WHERE observation_id=$1',
      [observationId],
    );
    assert.equal(count.rows[0].count, 1);
    const rolledBack = { ...input, model_revision: 'b'.repeat(40) };
    await saveTransaction(rolledBack, true);
    const { status, rating, severity_score, truncated, inference_ms, error_code, ...identity } =
      rolledBack;
    assert.equal(await store.find(client, identity), null);
    const replay = await saveTransaction({ ...input, rating: 4, severity_score: 0.95 });
    assert.equal(replay.inserted, false);
    assert.deepEqual(replay.result, results[0].result);
  } finally {
    await pool.end();
    if (provisioned) {
      await client.query(`DROP OWNED BY "${role}"`);
      await client.query(`DROP ROLE "${role}"`);
    }
  }
});

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

async function insertObservation(f, id = randomUUID(), snippet = {}) {
  const payload = {
    authorDetails: { channelId: 'test-viewer-channel' },
    snippet: {
      type: 'textMessageEvent',
      liveChatId: 'test-live-chat',
      publishedAt: '2026-09-20T00:00:00Z',
      textMessageDetails: { messageText: 'Hello shadow fixture' },
      ...snippet,
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
        $8,
        clock_timestamp(),
        $6::jsonb,
        $7
      )
    `,
    [
      id,
      f.channelId,
      f.sessionId,
      f.runId,
      `message-${id}`,
      serialized,
      payloadHash,
      payload.snippet.type,
    ],
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

test('shadow coordinator drains only text in the selected run and skips persisted errors after restart', async () => {
  const { AiShadowCandidateReader } = source(
    'apps/worker/src/ingestion/ai-shadow-candidate-reader.ts',
  );
  const { AiShadowResultWriter } = source('apps/worker/src/ingestion/ai-shadow-result-writer.ts');
  const { AiShadowCoordinator } = source('apps/worker/src/ingestion/ai-shadow-coordinator.ts');
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 2000,
    options: `-c search_path=${schema}`,
    statement_timeout: 5000,
  });
  const model = {
    model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
    model_revision: 'c'.repeat(40),
    model_variant: 'INT8',
    adapter_version: 'coordinator-test-1',
  };
  try {
    const f = await fixture();
    const other = await fixture();
    const firstId = await insertObservation(f);
    const secondId = await insertObservation(f, randomUUID(), {
      textMessageDetails: null,
      displayMessage: 'Fallback display text',
    });
    await insertObservation(f, randomUUID(), { type: 'userBannedEvent' });
    await insertObservation(f, randomUUID(), { textMessageDetails: { messageText: ' \t\n ' } });
    await insertObservation(f, randomUUID(), { textMessageDetails: { messageText: 123 } });
    const foreignId = await insertObservation(other);
    const reader = new AiShadowCandidateReader(pool, model);
    const writer = new AiShadowResultWriter(pool);
    const inferred = [];
    const runner = {
      async predict(identity, text) {
        // Both connections must remain available while inference runs.
        const connections = await Promise.allSettled([pool.connect(), pool.connect()]);
        for (const connection of connections) {
          if (connection.status === 'fulfilled') connection.value.release();
        }
        for (const connection of connections) {
          if (connection.status === 'rejected') throw connection.reason;
        }
        inferred.push({ id: identity.observation_id, text });
        return {
          ...identity,
          status: 'ERROR',
          rating: null,
          severity_score: null,
          truncated: null,
          inference_ms: null,
          error_code: 'INFERENCE_TIMEOUT',
        };
      },
    };
    const first = new AiShadowCoordinator(reader, runner, writer);
    const signal = new AbortController().signal;
    assert.equal((await first.tick(f.runId, signal)).kind, 'INSERTED');
    const restarted = new AiShadowCoordinator(
      new AiShadowCandidateReader(pool, model),
      runner,
      writer,
    );
    assert.equal((await restarted.tick(f.runId, signal)).kind, 'INSERTED');
    assert.equal((await restarted.tick(f.runId, signal)).kind, 'IDLE');
    assert.deepEqual(
      inferred.map((entry) => entry.id),
      [firstId, secondId],
    );
    assert.deepEqual(
      inferred.map((entry) => entry.text),
      ['Hello shadow fixture', 'Fallback display text'],
    );
    const stored = await client.query(
      'SELECT observation_id, status FROM youtube_ai_shadow_results WHERE run_id=$1',
      [f.runId],
    );
    assert.equal(stored.rowCount, 2);
    assert.ok(stored.rows.every((row) => row.status === 'ERROR'));
    assert.equal((await reader.next(other.runId)).identity.observation_id, foreignId);
    const revised = new AiShadowCandidateReader(pool, { ...model, model_revision: 'd'.repeat(40) });
    assert.equal((await revised.next(f.runId)).identity.observation_id, firstId);
    for (const table of ['youtube_chat_classifications', 'youtube_moderation_action_plans']) {
      const rows = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
      assert.equal(rows.rows[0].count, 0);
    }
  } finally {
    await pool.end();
  }
});

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
