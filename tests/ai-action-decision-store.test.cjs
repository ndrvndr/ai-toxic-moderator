const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');
const { AiActionDecisionStore } = source('apps/worker/src/ingestion/ai-action-decision-store.ts');
const { AiShadowStore } = source('apps/worker/src/ingestion/ai-shadow-store.ts');
const { AiActionDecisionCandidateReader } = source(
  'apps/worker/src/ingestion/ai-action-decision-candidate-reader.ts',
);
const { AiActionDecisionCycle } = source('apps/worker/src/ingestion/ai-action-decision-cycle.ts');
const { transaction, readLiveEvents } = source('packages/persistence/src/index.ts');
const { storedAiActionDecision } = source('packages/contracts/src/index.ts');
const { AiActionPlanStore } = source('apps/worker/src/ingestion/ai-action-plan-store.ts');
const { AiActionPlanCycle } = source('apps/worker/src/ingestion/ai-action-plan-cycle.ts');
const { AiDispatchProvenance, readAiActionEvidence } = source(
  'apps/worker/src/ingestion/ai-dispatch-provenance.ts',
);
const { DeleteExecutionStore } = source('apps/worker/src/ingestion/delete-execution-store.ts');
const { BanExecutionStore } = source('apps/worker/src/ingestion/ban-execution-store.ts');
const { DeleteEligibilityStore } = source('apps/worker/src/ingestion/delete-eligibility-store.ts');
const { BanEligibilityStore } = source('apps/worker/src/ingestion/ban-eligibility-store.ts');
const { DeleteExecutor } = source('apps/worker/src/ingestion/delete-executor.ts');
const { BanExecutor } = source('apps/worker/src/ingestion/ban-executor.ts');
const { DeleteCandidateStore } = source('apps/worker/src/ingestion/delete-candidate-store.ts');
const { BanCandidateStore } = source('apps/worker/src/ingestion/ban-candidate-store.ts');

const schema = `ai_decisions_${randomUUID().replaceAll('-', '')}`;
const workerRole = `ai_decision_worker_${randomUUID().replaceAll('-', '')}`;
const apiRole = `ai_decision_api_${randomUUID().replaceAll('-', '')}`;
let admin, worker, api, migrate;
let schemaCreated = false,
  workerCreated = false,
  apiCreated = false;
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Set TEST_DATABASE_URL to an admin-capable local test database.');
  ({ migrate } = await import('../scripts/database.mjs'));
  const { provisionWorkerRole } = await import('../scripts/worker-role.mjs');
  const { provisionRuntimeRole } = await import('../scripts/runtime-role.mjs');
  admin = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await admin.query(`SET search_path TO ${schema}`);
  await migrate(admin);
  await provisionWorkerRole(admin, { role: workerRole, password: randomUUID(), schema });
  workerCreated = true;
  await provisionRuntimeRole(admin, { role: apiRole, password: randomUUID(), schema });
  apiCreated = true;
  const pool = (role) =>
    new Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c role=${role}`,
      max: 4,
      statement_timeout: 10000,
      connectionTimeoutMillis: 3000,
    });
  worker = pool(workerRole);
  api = pool(apiRole);
});
after(async () => {
  try {
    if (worker) await worker.end();
    if (api) await api.end();
  } finally {
    if (admin) {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        if (workerCreated) await admin.query(`DROP ROLE ${workerRole}`);
        if (apiCreated) await admin.query(`DROP ROLE ${apiRole}`);
      } finally {
        await admin.end();
      }
    }
  }
});
const model = {
  model_id: 'test/model',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8',
  adapter_version: 'laskar-shadow-1',
};
function configuration(overrides = {}) {
  return {
    schema_version: 1,
    automatic_actions_enabled: true,
    model,
    score_metric: 'EXPECTED_SEVERITY',
    delete: { enabled: true, threshold: 0.4 },
    timeout: { enabled: true, threshold: 0.6, duration_seconds: 60 },
    ban: { enabled: true, threshold: 0.9 },
    ...overrides,
  };
}
async function fixture({
  saved = true,
  score = 0.7,
  enabled = true,
  author = `UC${'a'.repeat(22)}`,
  blacklisted = false,
  result = true,
  resultOverrides = {},
  configurationOverrides = {},
  eventType = 'textMessageEvent',
} = {}) {
  const f = {
    channelId: randomUUID(),
    accountId: randomUUID(),
    sessionId: randomUUID(),
    runId: randomUUID(),
    observationId: randomUUID(),
    classificationId: randomUUID(),
    externalMessageId: `message-${randomUUID()}`,
    author,
  };
  await admin.query('INSERT INTO accounts(id, display_name) VALUES ($1,$2)', [
    f.accountId,
    'AI decision owner',
  ]);
  await admin.query('INSERT INTO channels(id, display_name) VALUES ($1,$2)', [
    f.channelId,
    'AI decision channel',
  ]);
  await admin.query(
    "INSERT INTO channel_memberships(channel_id, account_id, role) VALUES ($1,$2,'OWNER')",
    [f.channelId, f.accountId],
  );
  await admin.query('INSERT INTO youtube_channels(channel_id, youtube_channel_id) VALUES ($1,$2)', [
    f.channelId,
    `channel-${randomUUID()}`,
  ]);
  await admin.query(
    "INSERT INTO stream_sessions(id, channel_id, label, source) VALUES ($1,$2,$3,'YOUTUBE')",
    [f.sessionId, f.channelId, 'AI decision broadcast'],
  );
  await admin.query(
    'INSERT INTO youtube_broadcasts(session_id, channel_id, youtube_broadcast_id, live_chat_id) VALUES ($1,$2,$3,$4)',
    [f.sessionId, f.channelId, `broadcast-${randomUUID()}`, `chat-${randomUUID()}`],
  );
  if (saved)
    await admin.query(
      'INSERT INTO channel_ai_moderation_settings(id, channel_id, revision, configuration, created_by) VALUES ($1,$2,1,$3::jsonb,$4)',
      [
        randomUUID(),
        f.channelId,
        JSON.stringify(
          configuration({ automatic_actions_enabled: enabled, ...configurationOverrides }),
        ),
        f.accountId,
      ],
    );
  if (blacklisted)
    await admin.query(
      'INSERT INTO channel_custom_blacklists(id, channel_id, revision, configuration, created_by) VALUES ($1,$2,1,$3::jsonb,$4)',
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
              pattern: 'abc',
              match_type: 'WORD',
              action: 'DELETE',
            },
          ],
        }),
        f.accountId,
      ],
    );
  await admin.query(
    'INSERT INTO monitoring_runs(id, channel_id, session_id, requested_by_account_id, credential_account_id) VALUES ($1,$2,$3,$4,$4)',
    [f.runId, f.channelId, f.sessionId, f.accountId],
  );
  const payload = {
    id: f.externalMessageId,
    snippet: {
      type: eventType,
      textMessageDetails: { messageText: blacklisted ? 'abc' : 'hello viewer' },
    },
    ...(author === null ? {} : { authorDetails: { channelId: author } }),
  };
  await admin.query(
    `INSERT INTO youtube_chat_observations(id, channel_id, session_id, first_observed_run_id, external_message_id, event_type, published_at, payload, payload_hash)
    VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp(),$7::jsonb,$8)`,
    [
      f.observationId,
      f.channelId,
      f.sessionId,
      f.runId,
      f.externalMessageId,
      eventType,
      JSON.stringify(payload),
      createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    ],
  );
  await admin.query(
    `INSERT INTO youtube_chat_classifications(id, channel_id, session_id, observation_id, run_id, classifier_version, policy_version, outcome, primary_category, severity, reason_code, reason, signals)
    VALUES ($1,$2,$3,$4,$5,'fixture-1','policy-1','ALLOW',NULL,0,'NO_RULE_MATCH','Baseline fixture.','[]'::jsonb)`,
    [f.classificationId, f.channelId, f.sessionId, f.observationId, f.runId],
  );
  f.scope = {
    channel_id: f.channelId,
    session_id: f.sessionId,
    run_id: f.runId,
    observation_id: f.observationId,
    classification_id: f.classificationId,
  };
  f.result = {
    channel_id: f.channelId,
    session_id: f.sessionId,
    run_id: f.runId,
    observation_id: f.observationId,
    ...model,
    status: 'SUCCEEDED',
    rating: 2,
    severity_score: score,
    truncated: false,
    inference_ms: 6,
    error_code: null,
    ...resultOverrides,
  };
  f.modelResultId = result
    ? (await transaction(worker, (client) => new AiShadowStore().save(client, f.result))).id
    : null;
  return f;
}
const save = (f, overrides = {}) =>
  transaction(worker, (client) =>
    new AiActionDecisionStore().save(client, {
      ...f.scope,
      model_result_id: f.modelResultId,
      ...overrides,
    }),
  );
const actions = (record) => record.decision.plans.map((plan) => plan.action);
async function activate(f) {
  await admin.query(
    "UPDATE monitoring_runs SET status='RUNNING', started_at=clock_timestamp() WHERE id=$1",
    [f.runId],
  );
  await admin.query('INSERT INTO youtube_chat_checkpoints(session_id) VALUES($1)', [f.sessionId]);
  await admin.query(
    `INSERT INTO google_credentials(account_id,access_token_ciphertext,refresh_token_ciphertext,expires_at,scopes)
    VALUES($1,'fixture-only','fixture-only',clock_timestamp(), 'https://www.googleapis.com/auth/youtube.force-ssl')`,
    [f.accountId],
  );
}
const materialize = (f, record) =>
  transaction(worker, (client) => new AiActionPlanStore().save(client, record.id, f.runId));

test('committed audit and plan events replay in order without duplicate notifications', async () => {
  const f = await fixture();
  await activate(f);
  const record = await save(f);
  await save(f);
  const feed = () =>
    transaction(api, (client) =>
      readLiveEvents(client, {
        channelId: f.channelId,
        sessionId: f.sessionId,
        after: '0',
      }),
    );
  assert.deepEqual((await feed()).items, [
    { sequence: '1', run_id: f.runId, event_type: 'chat.updated' },
  ]);
  await assert.rejects(
    transaction(worker, async (client) => {
      await new AiActionPlanStore().save(client, record.id, f.runId);
      throw new Error('Rollback event and plans');
    }),
    /Rollback event and plans/,
  );
  assert.equal((await feed()).watermark, '1');
  await materialize(f, record);
  await materialize(f, record);
  assert.deepEqual((await feed()).items, [
    { sequence: '1', run_id: f.runId, event_type: 'chat.updated' },
    { sequence: '2', run_id: f.runId, event_type: 'chat.updated' },
  ]);
  assert.equal((await feed()).watermark, '2');
});

test('event insertion failure rolls back audit or new plans even when callers catch the failure', async () => {
  const f = await fixture();
  await activate(f);
  const failEvent = (client) => ({
    query(sql, values) {
      if (sql.includes('INSERT INTO live_events(')) throw new Error('Event insert failed');
      return client.query(sql, values);
    },
  });
  await transaction(worker, async (client) => {
    await assert.rejects(
      new AiActionDecisionStore().save(failEvent(client), {
        ...f.scope,
        model_result_id: f.modelResultId,
      }),
      /Event insert failed/,
    );
    assert.deepEqual(await counts(f, client), { decisions: 0, queued_plans: 0, events: 0 });
  });
  const record = await save(f);
  await transaction(worker, async (client) => {
    await assert.rejects(
      new AiActionPlanStore().save(failEvent(client), record.id, f.runId),
      /Event insert failed/,
    );
    assert.deepEqual(await counts(f, client), { decisions: 1, queued_plans: 0, events: 1 });
  });
  await materialize(f, record);
  const counter = await api.query(
    'SELECT last_sequence::text AS sequence FROM live_event_counters WHERE session_id=$1',
    [f.sessionId],
  );
  assert.equal(counter.rows[0].sequence, '2');
});

test('AI action slots materialize atomically with worker permissions and concurrent replay reuses IDs', async () => {
  for (const [score, expected] of [
    [0.5, ['DELETE']],
    [0.7, ['DELETE', 'TIMEOUT']],
    [0.95, ['DELETE', 'BAN']],
  ]) {
    const f = await fixture({ score });
    await activate(f);
    const record = await save(f);
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => materialize(f, record)),
    );
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const values = results.map((result) => result.value);
    assert.deepEqual(
      values[0].map((item) => item.plan.action),
      expected,
    );
    assert.equal(values.flat().filter((item) => !item.reused).length, expected.length);
    assert.deepEqual(
      values[0].map((item) => item.id),
      values[1].map((item) => item.id),
    );
    assert.deepEqual(await counts(f), { decisions: 1, queued_plans: expected.length, events: 2 });
    assert.equal(
      (await transaction(worker, (client) => readAiActionEvidence(client, record.id, f.runId))).id,
      record.id,
    );
    const provenance = new AiDispatchProvenance(worker);
    for (const item of values[0]) {
      const slot = item.plan.action === 'DELETE' ? 'message' : 'author';
      assert.equal(await provenance.allows(item.id, f.channelId, f.sessionId, slot, f.runId), true);
      assert.equal(
        await provenance.allows(item.id, f.channelId, randomUUID(), slot, f.runId),
        false,
      );
      assert.equal(
        await provenance.allows(item.id, f.channelId, f.sessionId, slot, randomUUID()),
        false,
      );
    }
  }
});

test('plan loop recovers a committed audit after restart and settings edits retain captured decisions', async () => {
  const f = await fixture();
  await activate(f);
  await save(f);
  await admin.query(
    `INSERT INTO channel_ai_moderation_settings(id,channel_id,revision,configuration,created_by)
    VALUES($1,$2,2,$3::jsonb,$4)`,
    [
      randomUUID(),
      f.channelId,
      JSON.stringify(configuration({ automatic_actions_enabled: false })),
      f.accountId,
    ],
  );
  const cycle = new AiActionPlanCycle(f.runId, worker);
  assert.equal((await cycle.tick(new AbortController().signal)).inserted, 2);
  assert.equal(
    (await new AiActionPlanCycle(f.runId, worker).tick(new AbortController().signal)).kind,
    'IDLE',
  );
  assert.deepEqual(await counts(f), { decisions: 1, queued_plans: 2, events: 2 });
});

test('no-action audits, unavailable authors and stopped runs never invent author actions', async () => {
  for (const options of [
    { enabled: false },
    { saved: false },
    { blacklisted: true },
    { score: 0.1 },
    { resultOverrides: { truncated: true } },
  ]) {
    const f = await fixture(options);
    await activate(f);
    const record = await save(f);
    assert.deepEqual(await materialize(f, record), []);
  }
  const missing = await fixture({ author: null });
  await activate(missing);
  assert.deepEqual(
    (await materialize(missing, await save(missing))).map((item) => item.plan.action),
    ['DELETE'],
  );
  const stopped = await fixture();
  const record = await save(stopped);
  assert.deepEqual(await materialize(stopped, record), []);
  await activate(stopped);
  await admin.query(
    "UPDATE monitoring_runs SET status='STOPPED', stop_requested_at=clock_timestamp(), finished_at=clock_timestamp() WHERE id=$1",
    [stopped.runId],
  );
  assert.deepEqual(await materialize(stopped, record), []);
});

test('built-in actions take priority and a forged reserved policy cannot authorize dispatch', async () => {
  const f = await fixture({ score: 0.95 });
  await activate(f);
  const record = await save(f);
  const original = await materialize(f, record);
  const fakeId = randomUUID();
  await admin.query(
    `INSERT INTO youtube_moderation_action_plans(id,channel_id,session_id,classification_id,policy_version,action,reason)
    VALUES($1,$2,$3,$4,'ai-forged:message','DELETE','Forged plan')`,
    [fakeId, f.channelId, f.sessionId, f.classificationId],
  );
  assert.equal(
    await new AiDispatchProvenance(worker).allows(
      fakeId,
      f.channelId,
      f.sessionId,
      'message',
      f.runId,
    ),
    false,
  );
  const builtInId = randomUUID();
  await admin.query(
    `INSERT INTO youtube_moderation_action_plans(id,channel_id,session_id,classification_id,policy_version,action,reason,duration_seconds)
    VALUES($1,$2,$3,$4,'settings-fixture','TIMEOUT','Explicit built-in rule',60)`,
    [builtInId, f.channelId, f.sessionId, f.classificationId],
  );
  assert.deepEqual(await materialize(f, record), []);
  for (const item of original)
    assert.equal(
      await new AiDispatchProvenance(worker).allows(
        item.id,
        f.channelId,
        f.sessionId,
        item.plan.action === 'DELETE' ? 'message' : 'author',
        f.runId,
      ),
      false,
    );
  for (const Store of [DeleteCandidateStore, BanCandidateStore]) {
    const selected = [];
    let cursor = null;
    for (let i = 0; i < 100; i++) {
      const candidate = await new Store(worker).next(cursor);
      if (!candidate) break;
      selected.push(candidate.planId);
      cursor = candidate.planId;
    }
    assert.ok(!selected.includes(fakeId));
    assert.ok(original.every((item) => !selected.includes(item.id)));
  }
});

test('plan failure or caller rollback never leaves one half of an AI action bundle', async () => {
  const f = await fixture();
  await activate(f);
  const record = await save(f);
  await assert.rejects(
    transaction(worker, async (client) => {
      await new AiActionPlanStore().save(client, record.id, f.runId);
      throw new Error('Caller rollback');
    }),
    /Caller rollback/,
  );
  await transaction(worker, async (client) => {
    let inserts = 0;
    const failing = {
      query(sql, values) {
        if (sql.includes('INSERT INTO youtube_moderation_action_plans') && ++inserts === 2)
          throw new Error('Author slot failed');
        return client.query(sql, values);
      },
    };
    await assert.rejects(
      new AiActionPlanStore().save(failing, record.id, f.runId),
      /Author slot failed/,
    );
    assert.deepEqual(await counts(f, client), { decisions: 1, queued_plans: 0, events: 1 });
  });
  await assert.rejects(materialize({ ...f, runId: randomUUID() }, record), /evidence/);
  assert.deepEqual(await counts(f), { decisions: 1, queued_plans: 0, events: 1 });
});

test('AI executor authorization enforces configured run, kill switches, memberships and run state', async () => {
  const f = await fixture();
  await activate(f);
  const plans = await materialize(f, await save(f));
  const deletion = await new DeleteExecutionStore(worker).ensure(
    plans[0].id,
    f.channelId,
    f.sessionId,
  );
  const ban = await new BanExecutionStore(worker).ensure(plans[1].id, f.channelId, f.sessionId);
  for (const [Store, execution] of [
    [DeleteEligibilityStore, deletion],
    [BanEligibilityStore, ban],
  ]) {
    let enabled = true;
    let selectedRun = f.runId;
    const eligibility = new Store(
      worker,
      () => enabled,
      null,
      () => selectedRun,
    );
    assert.deepEqual(await eligibility.resolve(execution), { accountId: f.accountId });
    assert.equal(await new Store(worker, () => true).resolve(execution), null);
    selectedRun = randomUUID();
    assert.equal(await eligibility.resolve(execution), null);
    selectedRun = f.runId;
    enabled = false;
    assert.equal(await eligibility.resolve(execution), null);
    enabled = true;
    await admin.query("UPDATE channel_memberships SET role='OPERATOR' WHERE channel_id=$1", [
      f.channelId,
    ]);
    assert.equal(await eligibility.resolve(execution), null);
    await admin.query("UPDATE channel_memberships SET role='OWNER' WHERE channel_id=$1", [
      f.channelId,
    ]);
  }
  await admin.query(
    "UPDATE monitoring_runs SET status='STOPPING',stop_requested_at=clock_timestamp() WHERE id=$1",
    [f.runId],
  );
  assert.equal(
    await new DeleteEligibilityStore(
      worker,
      () => true,
      null,
      () => f.runId,
    ).resolve(deletion),
    null,
  );
  assert.equal(
    await new BanEligibilityStore(
      worker,
      () => true,
      null,
      () => f.runId,
    ).resolve(ban),
    null,
  );
});

test('AI delete and author executors dispatch through committed claims once and UNKNOWN stays blocked', async () => {
  const f = await fixture();
  await activate(f);
  const plans = await materialize(f, await save(f));
  let deletes = 0,
    bans = 0;
  const tokens = {
    async accessToken(accountId) {
      assert.equal(accountId, f.accountId);
      return 'fixture-token';
    },
  };
  const deletion = new DeleteExecutor(
    new DeleteExecutionStore(worker),
    new DeleteEligibilityStore(
      worker,
      () => true,
      null,
      () => f.runId,
    ),
    tokens,
    {
      async deleteMessage(input) {
        deletes++;
        assert.equal(input.externalMessageId, f.externalMessageId);
        assert.equal(
          (
            await admin.query(
              `SELECT a.id FROM youtube_delete_attempts a JOIN youtube_delete_executions e ON e.id=a.execution_id
        WHERE e.external_message_id=$1 AND a.status='DISPATCHED'`,
              [f.externalMessageId],
            )
          ).rowCount,
          1,
        );
        return { status: 'SUCCEEDED', http_status: 204 };
      },
    },
  );
  const input = { channelId: f.channelId, sessionId: f.sessionId, ownerId: randomUUID() };
  const deletesResult = await Promise.allSettled([
    deletion.execute({ ...input, planId: plans[0].id }),
    deletion.execute({ ...input, planId: plans[0].id, ownerId: randomUUID() }),
  ]);
  for (const result of deletesResult) if (result.status === 'rejected') throw result.reason;
  assert.equal(deletes, 1);
  const ban = new BanExecutor(
    new BanExecutionStore(worker),
    new BanEligibilityStore(
      worker,
      () => true,
      null,
      () => f.runId,
    ),
    tokens,
    {
      async banUser(input) {
        bans++;
        assert.equal(input.authorChannelId, f.author);
        return { status: 'UNKNOWN', http_status: null, code: 'TRANSPORT_ERROR' };
      },
    },
    {
      async resolve() {
        return { status: 'RESOLVED', channelId: `UC${'b'.repeat(22)}` };
      },
    },
  );
  assert.equal((await ban.execute({ ...input, planId: plans[1].id })).status, 'RECORDED');
  assert.equal(
    (await ban.execute({ ...input, planId: plans[1].id, ownerId: randomUUID() })).reason,
    'DISPATCH_BLOCKED',
  );
  assert.equal(bans, 1);
});

async function counts(f, connection = admin) {
  return (
    await connection.query(
      `SELECT
    (SELECT count(*)::int FROM youtube_ai_action_decisions WHERE run_id=$1 AND observation_id=$2) AS decisions,
    (SELECT count(*)::int FROM youtube_moderation_action_plans WHERE classification_id=$3) AS queued_plans,
    (SELECT count(*)::int FROM live_events WHERE session_id=$4) AS events`,
      [f.runId, f.observationId, f.classificationId, f.sessionId],
    )
  ).rows[0];
}

test('worker audit waits for terminal inference and restart does not repeat completed decisions', async () => {
  const f = await fixture({ result: false });
  const cycle = () =>
    new AiActionDecisionCycle(f.runId, new AiActionDecisionCandidateReader(worker, model), worker);
  assert.deepEqual(await cycle().tick(new AbortController().signal), { kind: 'IDLE' });
  assert.deepEqual(await counts(f), { decisions: 0, queued_plans: 0, events: 0 });
  const terminal = await transaction(worker, (client) =>
    new AiShadowStore().save(client, f.result),
  );
  assert.deepEqual(await cycle().tick(new AbortController().signal), {
    kind: 'INSERTED',
    observation_id: f.observationId,
    reason_code: 'THRESHOLD_MET',
  });
  const original = await transaction(worker, (client) =>
    new AiActionDecisionStore().find(client, f.scope),
  );
  assert.equal(original.model_result_id, terminal.id);
  assert.deepEqual(actions(original), ['DELETE', 'TIMEOUT']);
  assert.deepEqual(await cycle().tick(new AbortController().signal), { kind: 'IDLE' });
  assert.equal(
    (await transaction(worker, (client) => new AiActionDecisionStore().find(client, f.scope))).id,
    original.id,
  );
  assert.deepEqual(await counts(f), { decisions: 1, queued_plans: 0, events: 1 });
});

test('committed shadow output remains recoverable when classification becomes available later', async () => {
  const f = await fixture();
  // This isolated fixture models a result committed before a baseline classification.
  await admin.query('DELETE FROM youtube_chat_classifications WHERE id=$1', [f.classificationId]);
  const reader = new AiActionDecisionCandidateReader(worker, model);
  assert.equal(await reader.next(f.runId), null);
  await admin.query(
    `INSERT INTO youtube_chat_classifications(id, channel_id, session_id, observation_id, run_id,
    classifier_version, policy_version, outcome, primary_category, severity, reason_code, reason, signals)
    VALUES ($1,$2,$3,$4,$5,'fixture-late','policy-1','ALLOW',NULL,0,'NO_RULE_MATCH','Late classification.','[]'::jsonb)`,
    [f.classificationId, f.channelId, f.sessionId, f.observationId, f.runId],
  );
  const cycle = new AiActionDecisionCycle(f.runId, reader, worker);
  assert.equal((await cycle.tick(new AbortController().signal)).kind, 'INSERTED');
  assert.deepEqual(await counts(f), { decisions: 1, queued_plans: 0, events: 1 });
});

test('worker audits captured blacklist and disabled/missing policies without creating AI results', async () => {
  for (const [options, reason] of [
    [{ blacklisted: true }, 'BLACKLIST_MATCH'],
    [{ enabled: false }, 'AI_DISABLED'],
    [{ saved: false }, 'NO_SAVED_POLICY'],
  ]) {
    const f = await fixture({ ...options, result: false });
    const cycle = new AiActionDecisionCycle(
      f.runId,
      new AiActionDecisionCandidateReader(worker, model),
      worker,
    );
    assert.equal((await cycle.tick(new AbortController().signal)).reason_code, reason);
    assert.equal((await cycle.tick(new AbortController().signal)).kind, 'IDLE');
    assert.equal(
      (
        await admin.query('SELECT id FROM youtube_ai_shadow_results WHERE observation_id=$1', [
          f.observationId,
        ])
      ).rowCount,
      0,
    );
    assert.deepEqual(await counts(f), { decisions: 1, queued_plans: 0, events: 1 });
  }
});

test('worker audit recovers terminal inference errors and selects one original classification', async () => {
  const f = await fixture({
    resultOverrides: {
      status: 'ERROR',
      rating: null,
      severity_score: null,
      truncated: null,
      inference_ms: null,
      error_code: 'INFERENCE_TIMEOUT',
    },
  });
  await admin.query(
    `INSERT INTO youtube_chat_classifications(id, channel_id, session_id, observation_id, run_id,
    classifier_version, policy_version, outcome, primary_category, severity, reason_code, reason, signals)
    VALUES ($1,$2,$3,$4,$5,'fixture-second','policy-1','ALLOW',NULL,0,'NO_RULE_MATCH','Additional classification.','[]'::jsonb)`,
    [randomUUID(), f.channelId, f.sessionId, f.observationId, f.runId],
  );
  const cycle = new AiActionDecisionCycle(
    f.runId,
    new AiActionDecisionCandidateReader(worker, model),
    worker,
  );
  assert.equal((await cycle.tick(new AbortController().signal)).reason_code, 'INFERENCE_ERROR');
  assert.equal((await cycle.tick(new AbortController().signal)).kind, 'IDLE');
  const stored = await transaction(worker, (client) =>
    new AiActionDecisionStore().find(client, f.scope),
  );
  assert.equal(stored.decision.context.classification_id, f.classificationId);
  assert.deepEqual(actions(stored), []);
});

test('migration is repeatable and independent AI plans persist as audit only under worker permissions', async () => {
  await migrate(admin);
  for (const [score, expected] of [
    [0.2, []],
    [0.4, ['DELETE']],
    [0.7, ['DELETE', 'TIMEOUT']],
    [1, ['DELETE', 'BAN']],
  ]) {
    const f = await fixture({ score });
    const stored = await save(f);
    assert.equal(stored.reused, false);
    assert.deepEqual(actions(stored), expected);
    assert.equal(stored.model_result_id, f.modelResultId);
    assert.equal(stored.decision.snapshot.settings_revision, 1);
    assert.equal(stored.decision.context.external_message_id, f.externalMessageId);
    assert.deepEqual(await counts(f), { decisions: 1, queued_plans: 0, events: 1 });
    const { reused, ...record } = stored;
    assert.deepEqual(
      await transaction(worker, (client) => new AiActionDecisionStore().find(client, f.scope)),
      record,
    );
  }
});

test('SQL guards agree with planner precedence for every enabled-tier combination and endpoint thresholds', async () => {
  for (let mask = 0; mask < 8; mask++) {
    const f = await fixture({
      score: 1,
      configurationOverrides: {
        delete: { enabled: Boolean(mask & 1), threshold: 0 },
        timeout: { enabled: Boolean(mask & 2), threshold: 0.5, duration_seconds: 60 },
        ban: { enabled: Boolean(mask & 4), threshold: 1 },
      },
    });
    assert.deepEqual(
      actions(await save(f)),
      mask & 4 ? ['DELETE', 'BAN'] : mask & 2 ? ['DELETE', 'TIMEOUT'] : mask & 1 ? ['DELETE'] : [],
    );
  }
  const zero = await fixture({
    score: 0,
    configurationOverrides: {
      delete: { enabled: true, threshold: 0 },
    },
  });
  assert.deepEqual(actions(await save(zero)), ['DELETE']);
});

test('find is scoped, normalizes UUID casing, and returns null for unrelated observations', async () => {
  const f = await fixture();
  const stored = await save(f);
  const scope = Object.fromEntries(
    Object.entries(f.scope).map(([key, value]) => [key, value.toUpperCase()]),
  );
  await transaction(worker, async (client) => {
    const store = new AiActionDecisionStore();
    assert.equal((await store.find(client, scope)).id, stored.id);
    for (const key of ['channel_id', 'session_id', 'run_id', 'observation_id']) {
      assert.equal(await store.find(client, { ...f.scope, [key]: randomUUID() }), null);
    }
  });
});

test('competing writers create one decision and return the identical persisted audit', async () => {
  const f = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => save(f)));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const values = results.map((result) => result.value);
  assert.equal(new Set(values.map((value) => value.id)).size, 1);
  assert.equal(values.filter((value) => !value.reused).length, 1);
  for (const value of values) assert.deepEqual(value.decision, values[0].decision);
  assert.deepEqual(await counts(f), { decisions: 1, queued_plans: 0, events: 1 });
});

test('replay survives settings edits and another supplied model reference without changing the first decision', async () => {
  const f = await fixture();
  const original = await save(f);
  await admin.query(
    'INSERT INTO channel_ai_moderation_settings(id, channel_id, revision, configuration, created_by) VALUES ($1,$2,2,$3::jsonb,$4)',
    [
      randomUUID(),
      f.channelId,
      JSON.stringify(configuration({ automatic_actions_enabled: false })),
      f.accountId,
    ],
  );
  const newer = await transaction(worker, (client) =>
    new AiShadowStore().save(client, {
      ...f.result,
      model_revision: 'b'.repeat(40),
      severity_score: 1,
    }),
  );
  const replay = await save(f, { model_result_id: newer.id });
  assert.equal(replay.reused, true);
  assert.equal(replay.id, original.id);
  assert.equal(replay.model_result_id, original.model_result_id);
  assert.deepEqual(replay.decision, original.decision);
  assert.deepEqual(actions(replay), ['DELETE', 'TIMEOUT']);
});

test('missing output is terminal for this audit and late inference does not replan it', async () => {
  const f = await fixture({ result: false });
  const original = await save(f);
  assert.equal(original.decision.reason_code, 'OUTPUT_MISSING');
  const late = await transaction(worker, (client) => new AiShadowStore().save(client, f.result));
  const replay = await save(f, { model_result_id: late.id });
  assert.equal(replay.id, original.id);
  assert.equal(replay.model_result_id, null);
  assert.deepEqual(actions(replay), []);
});

test('no policy, disabled enforcement, errors, truncation, and mismatched model identities persist no-action reasons', async () => {
  for (const [options, reason] of [
    [{ saved: false }, 'NO_SAVED_POLICY'],
    [{ enabled: false }, 'AI_DISABLED'],
    [
      {
        resultOverrides: {
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
    [{ resultOverrides: { truncated: true } }, 'INPUT_TRUNCATED'],
    [{ resultOverrides: { adapter_version: 'other-adapter' } }, 'MODEL_MISMATCH'],
  ]) {
    const f = await fixture(options);
    const stored = await save(f);
    assert.equal(stored.decision.reason_code, reason);
    assert.deepEqual(actions(stored), []);
    assert.equal((await save(f)).id, stored.id);
  }
});

test('captured blacklist is recomputed from observed text and suppresses AI plans', async () => {
  const f = await fixture({ blacklisted: true, score: 1 });
  const stored = await save(f);
  assert.equal(stored.decision.reason_code, 'BLACKLIST_MATCH');
  assert.ok(stored.blacklist.selected_rule_id);
  assert.equal(stored.decision.model_output, null);
  assert.deepEqual(actions(stored), []);
  assert.deepEqual(await counts(f), { decisions: 1, queued_plans: 0, events: 1 });
});

test('missing author preserves deletion and explicit unavailable-target provenance', async () => {
  const f = await fixture({ author: null });
  const stored = await save(f);
  assert.equal(stored.decision.author_action_status, 'TARGET_UNAVAILABLE');
  assert.deepEqual(actions(stored), ['DELETE']);
});

test('substituted scopes, model IDs, non-text messages and injected decisions cannot be saved', async () => {
  const f = await fixture();
  const other = await fixture();
  for (const [key, value] of Object.entries(other.scope)) {
    await assert.rejects(save(f, { [key]: value }), /matching text observation/);
  }
  await assert.rejects(
    save(f, { model_result_id: other.modelResultId }),
    /Model result does not belong/,
  );
  await assert.rejects(save(f, { model_result_id: randomUUID() }), /Model result does not belong/);
  await assert.rejects(
    save(f, { decision: { action: 'BAN' } }),
    (error) => error.name === 'ZodError',
  );
  const event = await fixture({ eventType: 'userBannedEvent' });
  await assert.rejects(save(event), /matching text observation/);
  assert.deepEqual(await counts(f), { decisions: 0, queued_plans: 0, events: 0 });
});

test('a different classification cannot replace the decision for the same observation', async () => {
  const f = await fixture();
  await save(f);
  const classification = randomUUID();
  await admin.query(
    `INSERT INTO youtube_chat_classifications(id, channel_id, session_id, observation_id, run_id, classifier_version, policy_version, outcome, primary_category, severity, reason_code, reason, signals)
    VALUES ($1,$2,$3,$4,$5,'fixture-2','policy-1','ALLOW',NULL,0,'NO_RULE_MATCH','Another classification.','[]'::jsonb)`,
    [classification, f.channelId, f.sessionId, f.observationId, f.runId],
  );
  await assert.rejects(save(f, { classification_id: classification }), /another classification/);
});

test('caller rollback and caught insert failures leave no audit or queued plans', async () => {
  const f = await fixture();
  await assert.rejects(
    transaction(worker, async (client) => {
      await new AiActionDecisionStore().save(client, {
        ...f.scope,
        model_result_id: f.modelResultId,
      });
      throw new Error('Caller rollback');
    }),
    /Caller rollback/,
  );
  await transaction(worker, async (client) => {
    const failingClient = {
      query(text, parameters) {
        if (text.startsWith('INSERT INTO youtube_ai_action_decisions'))
          throw new Error('Injected insert failure');
        return client.query(text, parameters);
      },
    };
    await assert.rejects(
      new AiActionDecisionStore().save(failingClient, {
        ...f.scope,
        model_result_id: f.modelResultId,
      }),
      /Injected insert failure/,
    );
    assert.deepEqual(await counts(f, client), { decisions: 0, queued_plans: 0, events: 0 });
  });
  assert.deepEqual(await counts(f), { decisions: 0, queued_plans: 0, events: 0 });
  await assert.rejects(
    new AiActionDecisionStore().save(worker, { ...f.scope, model_result_id: f.modelResultId }),
    { code: '25P01' },
  );
});

test('database and shared contracts reject forged thresholds, targets and snapshot provenance', async () => {
  const f = await fixture();
  const stored = await save(f);
  for (const mutation of [
    { ...stored.decision, selected_threshold: 0.5 },
    { ...stored.decision, plans: stored.decision.plans.slice(0, 1) },
    {
      ...stored.decision,
      context: { ...stored.decision.context, external_message_id: 'other-message' },
    },
    { ...stored.decision, snapshot: { ...stored.decision.snapshot, settings_revision: 99 } },
    { ...stored.decision, model_output: { ...stored.decision.model_output, severity_score: 1 } },
  ]) {
    await assert.rejects(
      admin.query(
        `INSERT INTO youtube_ai_action_decisions(id, channel_id, session_id, run_id, observation_id, classification_id, model_result_id, decision, blacklist)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
        [
          randomUUID(),
          f.channelId,
          f.sessionId,
          f.runId,
          f.observationId,
          f.classificationId,
          f.modelResultId,
          JSON.stringify(mutation),
          JSON.stringify(stored.blacklist),
        ],
      ),
      { code: '23514' },
    );
  }
  const { reused, ...record } = stored;
  assert.equal(storedAiActionDecision.safeParse(record).success, true);
  assert.equal(
    storedAiActionDecision.safeParse({
      ...record,
      decision: { ...record.decision, selected_threshold: 0.5 },
    }).success,
    false,
  );
});

test('runtime roles have least privilege and admin updates/deletes cannot rewrite audit history', async () => {
  const f = await fixture();
  const stored = await save(f);
  assert.equal(
    (await api.query('SELECT id FROM youtube_ai_action_decisions WHERE id=$1', [stored.id]))
      .rowCount,
    1,
  );
  for (const connection of [api, worker]) {
    await assert.rejects(
      connection.query('UPDATE youtube_ai_action_decisions SET decision=decision WHERE id=$1', [
        stored.id,
      ]),
      { code: '42501' },
    );
    await assert.rejects(
      connection.query('DELETE FROM youtube_ai_action_decisions WHERE id=$1', [stored.id]),
      { code: '42501' },
    );
    await assert.rejects(connection.query('TRUNCATE youtube_ai_action_decisions'), {
      code: '42501',
    });
  }
  await assert.rejects(
    api.query('INSERT INTO youtube_ai_action_decisions(id) VALUES ($1)', [randomUUID()]),
    { code: '42501' },
  );
  await assert.rejects(
    admin.query('UPDATE youtube_ai_action_decisions SET decision=decision WHERE id=$1', [
      stored.id,
    ]),
    { code: '23514' },
  );
  await assert.rejects(
    admin.query('DELETE FROM youtube_ai_action_decisions WHERE id=$1', [stored.id]),
    { code: '23514' },
  );
  await assert.rejects(
    admin.query('DELETE FROM youtube_ai_shadow_results WHERE id=$1', [stored.model_result_id]),
    { code: '23503' },
  );
});
