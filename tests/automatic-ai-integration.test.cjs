const { before, after, afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');
const { AutomaticAiRunReader } = source('apps/worker/src/ingestion/automatic-ai-run-reader.ts');
const { createAutomaticAiCycle } = source('apps/worker/src/ingestion/automatic-ai-cycle.ts');
const { DeleteExecutionStore } = source('apps/worker/src/ingestion/delete-execution-store.ts');
const { BanExecutionStore } = source('apps/worker/src/ingestion/ban-execution-store.ts');
const { DeleteEligibilityStore } = source('apps/worker/src/ingestion/delete-eligibility-store.ts');
const { BanEligibilityStore } = source('apps/worker/src/ingestion/ban-eligibility-store.ts');
const { DeleteExecutor } = source('apps/worker/src/ingestion/delete-executor.ts');
const { BanExecutor } = source('apps/worker/src/ingestion/ban-executor.ts');
const { transaction, readLiveEvents } = source('packages/persistence/src/index.ts');

const schema = `automatic_ai_${randomUUID().replaceAll('-', '')}`;
const role = `automatic_ai_worker_${randomUUID().replaceAll('-', '')}`;
let admin, worker;
let schemaCreated = false;
let roleCreated = false;
const cycles = [];
const model = {
  model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8',
  adapter_version: 'laskar-shadow-1',
};
const signal = () => new AbortController().signal;

before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Set TEST_DATABASE_URL to an admin-capable local test database.');
  }
  const { migrate } = await import('../scripts/database.mjs');
  const { provisionWorkerRole } = await import('../scripts/worker-role.mjs');
  admin = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await admin.query(`SET search_path TO ${schema}`);
  await migrate(admin);
  await provisionWorkerRole(admin, { role, password: randomUUID(), schema });
  roleCreated = true;
  worker = new Pool({
    connectionString: url,
    options: `-c search_path=${schema} -c role=${role}`,
    max: 4,
    statement_timeout: 10000,
    connectionTimeoutMillis: 3000,
  });
});

afterEach(async () => {
  await Promise.all(cycles.splice(0).map((cycle) => cycle.dispose()));
  if (schemaCreated) {
    // Only this suite's isolated schema is in search_path. Do not clear application data.
    await admin.query(`UPDATE monitoring_runs SET status='STOPPED',
      stop_requested_at=COALESCE(stop_requested_at,clock_timestamp()), finished_at=clock_timestamp()
      WHERE status IN ('STARTING','RUNNING','STOPPING')`);
  }
});

after(async () => {
  try {
    if (worker) await worker.end();
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

function configuration(overrides = {}) {
  return {
    schema_version: 1,
    automatic_actions_enabled: true,
    model: { ...model },
    score_metric: 'EXPECTED_SEVERITY',
    delete: { enabled: true, threshold: 0.4 },
    timeout: { enabled: true, threshold: 0.6, duration_seconds: 30 },
    ban: { enabled: true, threshold: 0.9 },
    ...overrides,
  };
}

async function saveSettings(f, value) {
  const revision = (
    await admin.query(
      'SELECT COALESCE(max(revision),0)+1 AS revision FROM channel_ai_moderation_settings WHERE channel_id=$1',
      [f.channelId],
    )
  ).rows[0].revision;
  await admin.query(
    `INSERT INTO channel_ai_moderation_settings
    (id,channel_id,revision,configuration,created_by) VALUES($1,$2,$3,$4::jsonb,$5)`,
    [randomUUID(), f.channelId, revision, JSON.stringify(value), f.accountId],
  );
  return revision;
}

async function startRun(f, status = 'RUNNING') {
  const runId = randomUUID();
  await admin.query(
    `INSERT INTO monitoring_runs
    (id,channel_id,session_id,requested_by_account_id,credential_account_id)
    VALUES($1,$2,$3,$4,$5)`,
    [runId, f.channelId, f.sessionId, f.requesterId, f.accountId],
  );
  if (status === 'RUNNING') {
    await admin.query(
      "UPDATE monitoring_runs SET status='RUNNING',started_at=clock_timestamp() WHERE id=$1",
      [runId],
    );
  }
  return { ...f, runId };
}

async function stop(f) {
  await admin.query(
    `UPDATE monitoring_runs SET status='STOPPED',
    stop_requested_at=COALESCE(stop_requested_at,clock_timestamp()),finished_at=clock_timestamp()
    WHERE id=$1`,
    [f.runId],
  );
}

async function fixture({
  saved = true,
  settings = configuration(),
  status = 'RUNNING',
  blacklisted = false,
} = {}) {
  let f = {
    accountId: randomUUID(),
    requesterId: randomUUID(),
    channelId: randomUUID(),
    sessionId: randomUUID(),
    author: `UC${'a'.repeat(22)}`,
  };
  await admin.query('INSERT INTO accounts(id,display_name) VALUES($1,$2),($3,$4)', [
    f.accountId,
    'Automatic AI credential owner',
    f.requesterId,
    'Automatic AI requester',
  ]);
  await admin.query('INSERT INTO channels(id,display_name) VALUES($1,$2)', [
    f.channelId,
    'Automatic AI fixture',
  ]);
  await admin.query(
    `INSERT INTO channel_memberships(channel_id,account_id,role)
    VALUES($1,$2,'OWNER'),($1,$3,'MODERATOR')`,
    [f.channelId, f.accountId, f.requesterId],
  );
  await admin.query('INSERT INTO youtube_channels(channel_id,youtube_channel_id) VALUES($1,$2)', [
    f.channelId,
    `channel-${randomUUID()}`,
  ]);
  await admin.query(
    "INSERT INTO stream_sessions(id,channel_id,label,source) VALUES($1,$2,$3,'YOUTUBE')",
    [f.sessionId, f.channelId, 'Automatic AI integration fixture'],
  );
  await admin.query(
    `INSERT INTO youtube_broadcasts(session_id,channel_id,youtube_broadcast_id,live_chat_id)
    VALUES($1,$2,$3,$4)`,
    [f.sessionId, f.channelId, `broadcast-${randomUUID()}`, `chat-${randomUUID()}`],
  );
  await admin.query('INSERT INTO youtube_chat_checkpoints(session_id) VALUES($1)', [f.sessionId]);
  await admin.query(
    `INSERT INTO google_credentials
    (account_id,access_token_ciphertext,refresh_token_ciphertext,expires_at,scopes)
    VALUES($1,'fixture-only','fixture-only',clock_timestamp()+interval '1 hour',
    'https://www.googleapis.com/auth/youtube.force-ssl')`,
    [f.accountId],
  );
  if (saved) await saveSettings(f, settings);
  if (blacklisted) {
    await admin.query(
      `INSERT INTO channel_custom_blacklists
      (id,channel_id,revision,configuration,created_by) VALUES($1,$2,1,$3::jsonb,$4)`,
      [
        randomUUID(),
        f.channelId,
        JSON.stringify({
          schema_version: 1,
          enabled: true,
          rules: [
            {
              id: randomUUID(),
              enabled: true,
              pattern: 'blockedfixture',
              match_type: 'WORD',
              action: 'DELETE',
            },
          ],
        }),
        f.accountId,
      ],
    );
  }
  f = await startRun(f, status);
  return f;
}

async function classify(f) {
  await admin.query(
    `INSERT INTO youtube_chat_classifications
    (id,channel_id,session_id,observation_id,run_id,classifier_version,policy_version,
     outcome,primary_category,severity,reason_code,reason,signals)
    VALUES($1,$2,$3,$4,$5,'fixture-1','policy-1','ALLOW',NULL,0,'NO_RULE_MATCH','Local baseline fixture.','[]'::jsonb)`,
    [f.classificationId, f.channelId, f.sessionId, f.observationId, f.runId],
  );
}

async function observe(f, { baseline = true, text = 'Local AI fixture text' } = {}) {
  const observed = {
    ...f,
    observationId: randomUUID(),
    classificationId: randomUUID(),
    externalMessageId: `message-${randomUUID()}`,
  };
  const payload = {
    id: observed.externalMessageId,
    snippet: { type: 'textMessageEvent', textMessageDetails: { messageText: text } },
    authorDetails: { channelId: f.author },
  };
  await admin.query(
    `INSERT INTO youtube_chat_observations
    (id,channel_id,session_id,first_observed_run_id,external_message_id,event_type,published_at,payload,payload_hash)
    VALUES($1,$2,$3,$4,$5,'textMessageEvent',clock_timestamp(),$6::jsonb,$7)`,
    [
      observed.observationId,
      f.channelId,
      f.sessionId,
      f.runId,
      observed.externalMessageId,
      JSON.stringify(payload),
      createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    ],
  );
  if (baseline) await classify(observed);
  return observed;
}

function harness({ pool = worker, score = 0.75, output = {}, predict } = {}) {
  const h = { calls: [], constructions: 0, disposals: 0, statuses: [] };
  h.cycle = createAutomaticAiCycle(
    {
      AI_AUTOMATIC_ENABLED: true,
      AI_SHADOW_MODEL_REVISION: model.model_revision,
      AI_SHADOW_CACHE_DIRECTORY: '.cache/test-fixture-unused',
      AI_SHADOW_STARTUP_TIMEOUT_MS: 1000,
      AI_SHADOW_INFERENCE_TIMEOUT_MS: 1000,
    },
    pool,
    () => {
      h.constructions++;
      return {
        async predict(identity, text) {
          h.calls.push({ identity, text });
          if (predict) await predict(identity, text);
          return {
            ...identity,
            status: 'SUCCEEDED',
            rating: 2,
            severity_score: score,
            truncated: false,
            inference_ms: 1,
            error_code: null,
            ...output,
          };
        },
        async dispose() {
          h.disposals++;
        },
      };
    },
    (status) => h.statuses.push(status),
  );
  cycles.push(h.cycle);
  return h;
}

async function counts(f) {
  return (
    await admin.query(
      `SELECT
    (SELECT count(*)::int FROM youtube_ai_shadow_results WHERE run_id=$1) AS results,
    (SELECT count(*)::int FROM youtube_ai_action_decisions WHERE run_id=$1) AS decisions,
    (SELECT count(*)::int FROM youtube_moderation_action_plans p JOIN youtube_chat_classifications c
      ON c.id=p.classification_id WHERE c.run_id=$1 AND p.policy_version LIKE 'ai-%') AS plans,
    (SELECT count(*)::int FROM live_events WHERE run_id=$1) AS events`,
      [f.runId],
    )
  ).rows[0];
}
async function plans(f) {
  return (
    await admin.query(
      `SELECT p.id,p.action,p.duration_seconds FROM youtube_moderation_action_plans p
    JOIN youtube_chat_classifications c ON c.id=p.classification_id
    WHERE c.run_id=$1 AND p.policy_version LIKE 'ai-%' ORDER BY p.action`,
      [f.runId],
    )
  ).rows;
}
async function decision(f) {
  return (
    await admin.query(
      'SELECT decision FROM youtube_ai_action_decisions WHERE run_id=$1 AND observation_id=$2',
      [f.runId, f.observationId],
    )
  ).rows[0]?.decision;
}

test('restricted worker discovery follows STARTING, RUNNING, STOPPING and STOPPED states', async () => {
  const f = await fixture({ status: 'STARTING' });
  const reader = new AutomaticAiRunReader(worker, model);
  assert.deepEqual(await reader.next(), { kind: 'IDLE' });
  await admin.query(
    "UPDATE monitoring_runs SET status='RUNNING',started_at=clock_timestamp() WHERE id=$1",
    [f.runId],
  );
  assert.equal((await reader.next()).run_id, f.runId);
  await admin.query(
    "UPDATE monitoring_runs SET status='STOPPING',stop_requested_at=clock_timestamp() WHERE id=$1",
    [f.runId],
  );
  assert.deepEqual(await reader.next(), { kind: 'IDLE' });
  await stop(f);
  assert.deepEqual(await reader.next(), { kind: 'IDLE' });
  assert.equal((await worker.query('SELECT current_user AS role')).rows[0].role, role);
});

test('default, disabled, and incompatible model snapshots are excluded without inference', async () => {
  for (const options of [
    { saved: false },
    { settings: configuration({ automatic_actions_enabled: false }) },
    ...[
      { model_id: 'other/model' },
      { model_revision: 'b'.repeat(40) },
      { adapter_version: 'other-adapter' },
    ].map((changed) => ({ settings: configuration({ model: { ...model, ...changed } }) })),
  ]) {
    const f = await observe(await fixture(options));
    const h = harness();
    assert.equal((await h.cycle.tick(signal())).kind, 'IDLE');
    assert.equal(h.cycle.allowedRunId(), null);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(await counts(f), { results: 0, decisions: 0, plans: 0, events: 0 });
    await stop(f);
    await h.cycle.dispose();
  }
});

test('captured settings survive edits and one runner follows subsequent enabled runs', async () => {
  let f = await observe(await fixture());
  const first = f;
  const h = harness();
  await saveSettings(f, configuration({ automatic_actions_enabled: false }));
  await h.cycle.tick(signal());
  assert.equal((await decision(f)).snapshot.settings_revision, 1);
  assert.equal((await decision(f)).selected_tier, 'TIMEOUT');
  await stop(f);
  f = await observe(await startRun(f));
  assert.equal((await h.cycle.tick(signal())).kind, 'IDLE');
  assert.equal(h.cycle.allowedRunId(), null);
  assert.deepEqual(await counts(f), { results: 0, decisions: 0, plans: 0, events: 0 });
  await stop(f);
  await saveSettings(
    f,
    configuration({ timeout: { enabled: true, threshold: 0.85, duration_seconds: 30 } }),
  );
  f = await observe(await startRun(f));
  assert.equal((await h.cycle.tick(signal())).run_id, f.runId);
  assert.equal((await decision(f)).snapshot.settings_revision, 3);
  assert.equal((await decision(f)).selected_tier, 'DELETE');
  assert.deepEqual(
    h.calls.map((call) => call.identity.run_id),
    [first.runId, f.runId],
  );
  assert.equal(h.constructions, 1);
  assert.equal(h.disposals, 0);
});

test('committed inference, audits and plans replay after worker restart without duplicate events', async () => {
  const f = await observe(await fixture());
  const h = harness();
  await h.cycle.tick(signal());
  assert.deepEqual(await counts(f), { results: 1, decisions: 1, plans: 2, events: 3 });
  assert.deepEqual(
    (await plans(f)).map((plan) => plan.action),
    ['DELETE', 'TIMEOUT'],
  );
  assert.equal(
    Number((await plans(f)).find((plan) => plan.action === 'TIMEOUT').duration_seconds),
    30,
  );
  await h.cycle.tick(signal());
  assert.equal(h.calls.length, 1);
  await h.cycle.dispose();
  const restarted = harness();
  await restarted.cycle.tick(signal());
  assert.equal(restarted.calls.length, 0);
  assert.deepEqual(await counts(f), { results: 1, decisions: 1, plans: 2, events: 3 });
  const feed = await transaction(worker, (client) =>
    readLiveEvents(client, {
      channelId: f.channelId,
      sessionId: f.sessionId,
      after: '0',
    }),
  );
  assert.deepEqual(
    feed.items,
    ['1', '2', '3'].map((sequence) => ({
      sequence,
      run_id: f.runId,
      event_type: 'chat.updated',
    })),
  );
  assert.equal(feed.watermark, '3');
});

test('late baseline classification audits committed output without a second prediction', async () => {
  const f = await observe(await fixture(), { baseline: false });
  const h = harness();
  await h.cycle.tick(signal());
  assert.deepEqual(await counts(f), { results: 1, decisions: 0, plans: 0, events: 1 });
  await classify(f);
  await h.cycle.tick(signal());
  assert.equal(h.calls.length, 1);
  assert.deepEqual(await counts(f), { results: 1, decisions: 1, plans: 2, events: 3 });
});

test('automatic persistence selects the highest enabled delete or ban tier from captured scores', async () => {
  for (const [score, tier, expected] of [
    [0.5, 'DELETE', ['DELETE']],
    [0.95, 'BAN', ['BAN', 'DELETE']],
  ]) {
    const f = await observe(await fixture());
    const h = harness({ score });
    await h.cycle.tick(signal());
    assert.equal((await decision(f)).selected_tier, tier);
    const stored = await plans(f);
    assert.deepEqual(
      stored.map((plan) => plan.action),
      expected,
    );
    assert.ok(stored.every((plan) => plan.duration_seconds === null));
    assert.deepEqual(await counts(f), {
      results: 1,
      decisions: 1,
      plans: expected.length,
      events: 3,
    });
    await stop(f);
    await h.cycle.dispose();
  }
});

test('cancellation during simulated inference leaves no result, audit, plan or event', async () => {
  const f = await observe(await fixture());
  const controller = new AbortController();
  const h = harness({ predict: () => controller.abort() });
  await h.cycle.tick(controller.signal);
  assert.equal(h.cycle.allowedRunId(), null);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(await counts(f), { results: 0, decisions: 0, plans: 0, events: 0 });
});

test('failed, truncated and below-threshold outputs audit safely without actionable plans', async () => {
  for (const [options, reason] of [
    [{ score: 0.1 }, 'NO_THRESHOLD_MET'],
    [{ output: { truncated: true } }, 'INPUT_TRUNCATED'],
    [
      {
        output: {
          status: 'ERROR',
          rating: null,
          severity_score: null,
          truncated: null,
          inference_ms: null,
          error_code: 'INFERENCE_TIMEOUT',
        },
      },
      'INFERENCE_ERROR',
    ],
  ]) {
    const f = await observe(await fixture());
    const h = harness(options);
    await h.cycle.tick(signal());
    assert.equal((await decision(f)).reason_code, reason);
    assert.deepEqual(await counts(f), { results: 1, decisions: 1, plans: 0, events: 2 });
    await h.cycle.tick(signal());
    assert.equal(h.calls.length, 1);
    await stop(f);
    await h.cycle.dispose();
  }
});

test('blacklist matches skip inference and never materialize AI action slots', async () => {
  const f = await observe(await fixture({ blacklisted: true }), { text: 'blockedfixture' });
  const h = harness();
  await h.cycle.tick(signal());
  assert.equal(h.calls.length, 0);
  assert.equal((await decision(f)).reason_code, 'BLACKLIST_MATCH');
  assert.deepEqual(await counts(f), { results: 0, decisions: 1, plans: 0, events: 1 });
});

test('explicit built-in actions take priority over an otherwise selected AI tier', async () => {
  const f = await observe(await fixture());
  await admin.query(
    `INSERT INTO youtube_moderation_action_plans
    (id,channel_id,session_id,classification_id,policy_version,action,reason)
    VALUES($1,$2,$3,$4,'settings-fixture','DELETE','Explicit built-in action')`,
    [randomUUID(), f.channelId, f.sessionId, f.classificationId],
  );
  const h = harness();
  await h.cycle.tick(signal());
  assert.equal((await decision(f)).reason_code, 'THRESHOLD_MET');
  assert.deepEqual(await counts(f), { results: 1, decisions: 1, plans: 0, events: 2 });
});

test('current requester and credential memberships independently control discovery', async () => {
  const f = await fixture();
  const reader = new AutomaticAiRunReader(worker, model);
  for (const [account, restoredRole] of [
    [f.accountId, 'OWNER'],
    [f.requesterId, 'MODERATOR'],
  ]) {
    await admin.query(
      "UPDATE channel_memberships SET role='OPERATOR' WHERE channel_id=$1 AND account_id=$2",
      [f.channelId, account],
    );
    assert.deepEqual(await reader.next(), { kind: 'IDLE' });
    await admin.query(
      'UPDATE channel_memberships SET role=$3 WHERE channel_id=$1 AND account_id=$2',
      [f.channelId, account, restoredRole],
    );
    assert.equal((await reader.next()).run_id, f.runId);
    await admin.query('DELETE FROM channel_memberships WHERE channel_id=$1 AND account_id=$2', [
      f.channelId,
      account,
    ]);
    assert.deepEqual(await reader.next(), { kind: 'IDLE' });
    await admin.query(
      'INSERT INTO channel_memberships(channel_id,account_id,role) VALUES($1,$2,$3)',
      [f.channelId, account, restoredRole],
    );
  }
});

test('ended chat and closed sessions stop discovery and revoke selected dispatch permission', async () => {
  for (const target of ['chat', 'session']) {
    const f = await observe(await fixture());
    const h = harness();
    await h.cycle.tick(signal());
    if (target === 'chat') {
      await admin.query(
        'UPDATE youtube_chat_checkpoints SET chat_ended_at=clock_timestamp() WHERE session_id=$1',
        [f.sessionId],
      );
    } else {
      await admin.query('UPDATE stream_sessions SET closed_at=clock_timestamp() WHERE id=$1', [
        f.sessionId,
      ]);
    }
    assert.equal((await h.cycle.tick(signal())).kind, 'IDLE');
    assert.equal(h.cycle.allowedRunId(), null);
    assert.equal(h.calls.length, 1);
    await stop(f);
    await h.cycle.dispose();
  }
});

test('access loss during inference preserves output but blocks audits until authorization returns', async () => {
  const f = await observe(await fixture());
  const h = harness({
    predict: async () => {
      await admin.query(
        "UPDATE channel_memberships SET role='OPERATOR' WHERE channel_id=$1 AND account_id=$2",
        [f.channelId, f.requesterId],
      );
    },
  });
  assert.equal((await h.cycle.tick(signal())).kind, 'SCOPE_CHANGED');
  assert.equal(h.cycle.allowedRunId(), null);
  assert.deepEqual(await counts(f), { results: 1, decisions: 0, plans: 0, events: 1 });
  await admin.query(
    "UPDATE channel_memberships SET role='MODERATOR' WHERE channel_id=$1 AND account_id=$2",
    [f.channelId, f.requesterId],
  );
  await h.cycle.tick(signal());
  assert.equal(h.calls.length, 1);
  assert.deepEqual(await counts(f), { results: 1, decisions: 1, plans: 2, events: 3 });
});

test('a second eligible stream pauses discovery and real executor eligibility for saved plans', async () => {
  const f = await observe(await fixture());
  const h = harness();
  await h.cycle.tick(signal());
  const stored = await plans(f);
  const deletion = await new DeleteExecutionStore(worker).ensure(
    stored.find((p) => p.action === 'DELETE').id,
    f.channelId,
    f.sessionId,
  );
  const ban = await new BanExecutionStore(worker).ensure(
    stored.find((p) => p.action === 'TIMEOUT').id,
    f.channelId,
    f.sessionId,
  );
  const deletionEligibility = new DeleteEligibilityStore(
    worker,
    () => true,
    null,
    () => h.cycle.allowedRunId(),
  );
  const banEligibility = new BanEligibilityStore(
    worker,
    () => true,
    null,
    () => h.cycle.allowedRunId(),
  );
  assert.deepEqual(await deletionEligibility.resolve(deletion), { accountId: f.accountId });
  assert.deepEqual(await banEligibility.resolve(ban), { accountId: f.accountId });
  const second = await fixture();
  assert.equal((await new AutomaticAiRunReader(worker, model).next()).kind, 'CAPACITY_EXCEEDED');
  await h.cycle.tick(signal());
  assert.equal(h.cycle.allowedRunId(), null);
  assert.equal(await deletionEligibility.resolve(deletion), null);
  assert.equal(await banEligibility.resolve(ban), null);
  assert.equal(h.calls.length, 1);
  await stop(second);
  await h.cycle.tick(signal());
  assert.equal(h.cycle.allowedRunId(), f.runId);
  assert.deepEqual(await deletionEligibility.resolve(deletion), { accountId: f.accountId });
  await stop(f);
  assert.equal(await deletionEligibility.resolve(deletion), null);
  assert.equal(await banEligibility.resolve(ban), null);
});

test('a failed author slot rolls back the bundle and recovers from committed inference and audit', async () => {
  const f = await observe(await fixture());
  let inserts = 0;
  let failed = false;
  const failingPool = {
    query: (...args) => worker.query(...args),
    async connect() {
      const client = await worker.connect();
      return {
        query(sql, values) {
          if (
            !failed &&
            sql.includes('INSERT INTO youtube_moderation_action_plans') &&
            ++inserts === 2
          ) {
            failed = true;
            throw new Error('Author slot fixture failure');
          }
          return client.query(sql, values);
        },
        release: () => client.release(),
      };
    },
  };
  const h = harness({ pool: failingPool });
  await assert.rejects(h.cycle.tick(signal()), /Author slot fixture failure/);
  assert.equal(h.cycle.allowedRunId(), null);
  assert.deepEqual(await counts(f), { results: 1, decisions: 1, plans: 0, events: 2 });
  await h.cycle.tick(signal());
  assert.equal(h.calls.length, 1);
  assert.deepEqual(await counts(f), { results: 1, decisions: 1, plans: 2, events: 3 });
});

test('automatic selection authorizes simulated executors through committed claims without redispatch', async () => {
  const f = await observe(await fixture());
  const h = harness();
  await h.cycle.tick(signal());
  const stored = await plans(f);
  const input = { channelId: f.channelId, sessionId: f.sessionId, ownerId: randomUUID() };
  const tokens = {
    async accessToken(accountId) {
      assert.equal(accountId, f.accountId);
      return 'fixture-token';
    },
  };
  let deletes = 0;
  let bans = 0;
  const deletion = new DeleteExecutor(
    new DeleteExecutionStore(worker),
    new DeleteEligibilityStore(
      worker,
      () => true,
      null,
      () => h.cycle.allowedRunId(),
    ),
    tokens,
    {
      async deleteMessage() {
        deletes++;
        const committed = await admin.query(
          `SELECT a.id FROM youtube_delete_attempts a
        JOIN youtube_delete_executions e ON e.id=a.execution_id
        WHERE e.external_message_id=$1 AND a.status='DISPATCHED'`,
          [f.externalMessageId],
        );
        assert.equal(committed.rowCount, 1);
        return { status: 'SUCCEEDED', http_status: 204 };
      },
    },
  );
  const deleteInput = { ...input, planId: stored.find((p) => p.action === 'DELETE').id };
  assert.equal((await deletion.execute(deleteInput)).status, 'RECORDED');
  assert.equal((await deletion.execute(deleteInput)).reason, 'ALREADY_ATTEMPTED');
  const author = new BanExecutor(
    new BanExecutionStore(worker),
    new BanEligibilityStore(
      worker,
      () => true,
      null,
      () => h.cycle.allowedRunId(),
    ),
    tokens,
    {
      async banUser() {
        bans++;
        return { status: 'UNKNOWN', http_status: null, code: 'TRANSPORT_ERROR' };
      },
    },
    {
      async resolve() {
        return { status: 'RESOLVED', channelId: `UC${'b'.repeat(22)}` };
      },
    },
  );
  const authorInput = { ...input, planId: stored.find((p) => p.action === 'TIMEOUT').id };
  assert.equal((await author.execute(authorInput)).status, 'RECORDED');
  await h.cycle.dispose();
  const restarted = harness();
  await restarted.cycle.tick(signal());
  const afterRestart = new BanExecutor(
    new BanExecutionStore(worker),
    new BanEligibilityStore(
      worker,
      () => true,
      null,
      () => restarted.cycle.allowedRunId(),
    ),
    tokens,
    {
      async banUser() {
        assert.fail('UNKNOWN must not be redispatched.');
      },
    },
    {
      async resolve() {
        return { status: 'RESOLVED', channelId: `UC${'b'.repeat(22)}` };
      },
    },
  );
  assert.equal((await afterRestart.execute(authorInput)).reason, 'DISPATCH_BLOCKED');
  assert.equal(deletes, 1);
  assert.equal(bans, 1);
  assert.equal(restarted.calls.length, 0);
});
