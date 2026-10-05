const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Client, Pool } = require('pg');
const { source } = require('./helpers/source.cjs');
const { BlacklistActionStore } = source('apps/worker/src/ingestion/blacklist-action-store.ts');
const { ActionPlanStore } = source('apps/worker/src/ingestion/action-plan-store.ts');
const { BlacklistActionPlanner } = source(
  'packages/moderation-core/src/blacklist-action-planner.ts',
);
const { transaction } = source('packages/persistence/src/index.ts');
const { createClassificationStore } = source(
  'apps/worker/src/ingestion/create-classification-store.ts',
);
const { DeleteCandidateStore } = source('apps/worker/src/ingestion/delete-candidate-store.ts');
const { BanCandidateStore } = source('apps/worker/src/ingestion/ban-candidate-store.ts');
const { DeleteEligibilityStore } = source('apps/worker/src/ingestion/delete-eligibility-store.ts');
const { BanEligibilityStore } = source('apps/worker/src/ingestion/ban-eligibility-store.ts');
const { DeleteExecutionStore } = source('apps/worker/src/ingestion/delete-execution-store.ts');
const { BanExecutionStore } = source('apps/worker/src/ingestion/ban-execution-store.ts');
const { BlacklistDispatchProvenance } = source(
  'apps/worker/src/ingestion/blacklist-dispatch-provenance.ts',
);
const { DeleteExecutor } = source('apps/worker/src/ingestion/delete-executor.ts');
const { BanExecutor } = source('apps/worker/src/ingestion/ban-executor.ts');

async function activateDispatch(f) {
  await admin.query(
    "UPDATE monitoring_runs SET status = 'RUNNING', started_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
  await admin.query(
    'INSERT INTO youtube_chat_checkpoints(session_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [f.sessionId],
  );
  await admin.query(
    `INSERT INTO google_credentials(account_id, access_token_ciphertext, refresh_token_ciphertext, expires_at, scopes)
    VALUES ($1, 'test-only-access', 'test-only-refresh', clock_timestamp() + interval '1 hour', 'https://www.googleapis.com/auth/youtube.force-ssl')`,
    [f.accountId],
  );
}

async function dispatchFixture(options = {}) {
  const f = await fixture({ ...options, seedClassification: false });
  await classifyFixture(f);
  await activateDispatch(f);
  const decision = (
    await admin.query(
      'SELECT message_plan_id, author_plan_id FROM youtube_blacklist_decisions WHERE classification_id = $1',
      [f.classificationId],
    )
  ).rows[0];
  f.messagePlanId = decision.message_plan_id;
  f.authorPlanId = decision.author_plan_id;
  return f;
}

test('missing decision links and semantically forged blacklist evidence cannot dispatch', async () => {
  const f = await fixture({ text: 'Hello viewer', seedClassification: false });
  await admin.query(
    `INSERT INTO youtube_chat_classifications(id, channel_id, session_id, observation_id, run_id,
    classifier_version, policy_version, outcome, primary_category, severity, reason_code, reason, signals)
    VALUES ($1, $2, $3, $4, $5, 'rules-blacklist-1', 'policy-1', 'ACTION_REQUIRED', NULL, NULL,
      'BLACKLIST_MATCH', 'Forged fixture decision.', '[]'::jsonb)`,
    [f.classificationId, f.channelId, f.sessionId, f.observationId, f.runId],
  );
  const captured = (
    await admin.query(
      'SELECT run_id, channel_id, blacklist_id, blacklist_revision, configuration, source FROM monitoring_blacklist_snapshots WHERE run_id = $1',
      [f.runId],
    )
  ).rows[0];
  // Direct database insertion can pass structural checks; runtime must recompute the actual text.
  const forged = new BlacklistActionPlanner(captured).plan(
    {
      run_id: f.runId,
      channel_id: f.channelId,
      session_id: f.sessionId,
      classification_id: f.classificationId,
      external_message_id: f.externalMessageId,
      author_channel_id: f.author,
    },
    'abc',
  );
  const ids = await transaction(worker, async (client) => {
    const plans = new ActionPlanStore();
    const saved = [];
    for (const plan of forged.plans) saved.push((await plans.save(client, plan)).id);
    return saved;
  });
  await activateDispatch(f);
  const deletion = await new DeleteExecutionStore(worker).ensure(ids[0], f.channelId, f.sessionId);
  const timeout = await new BanExecutionStore(worker).ensure(ids[1], f.channelId, f.sessionId);
  const deleteEligibility = new DeleteEligibilityStore(worker, () => true);
  const banEligibility = new BanEligibilityStore(worker, () => true);
  assert.equal(await new DeleteCandidateStore(worker).next(null), null);
  assert.equal(await new BanCandidateStore(worker).next(null), null);
  assert.equal(await deleteEligibility.resolve(deletion), null);
  assert.equal(await banEligibility.resolve(timeout), null);
  await admin.query(
    `INSERT INTO youtube_blacklist_decisions(id, channel_id, session_id, classification_id,
    run_id, policy_version, bundle, message_plan_id, author_plan_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      randomUUID(),
      f.channelId,
      f.sessionId,
      f.classificationId,
      f.runId,
      forged.policy_version,
      JSON.stringify(forged),
      ids[0],
      ids[1],
    ],
  );
  assert.equal(await deleteEligibility.resolve(deletion), null);
  assert.equal(await banEligibility.resolve(timeout), null);
  const fail = () => {
    throw new Error('Ineligible evidence must not reach credentials or providers.');
  };
  const input = (planId) => ({
    planId,
    channelId: f.channelId,
    sessionId: f.sessionId,
    ownerId: randomUUID(),
  });
  assert.deepEqual(
    await new DeleteExecutor(
      new DeleteExecutionStore(worker),
      deleteEligibility,
      { accessToken: fail },
      { deleteMessage: fail },
    ).execute(input(ids[0])),
    { status: 'SKIPPED', reason: 'INELIGIBLE' },
  );
  assert.deepEqual(
    await new BanExecutor(
      new BanExecutionStore(worker),
      banEligibility,
      { accessToken: fail },
      { banUser: fail },
      { resolve: fail },
    ).execute(input(ids[1])),
    { status: 'SKIPPED', reason: 'INELIGIBLE' },
  );
  await admin.query(
    "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
});

test('missing author identity does not prevent eligible message deletion', async () => {
  const f = await dispatchFixture({ author: null });
  assert.equal(f.authorPlanId, null);
  const deletion = await new DeleteExecutionStore(worker).ensure(
    f.messagePlanId,
    f.channelId,
    f.sessionId,
  );
  assert.deepEqual(await new DeleteEligibilityStore(worker, () => true).resolve(deletion), {
    accountId: f.accountId,
  });
  assert.equal((await new DeleteCandidateStore(worker).next(null)).planId, f.messagePlanId);
  assert.equal(await new BanCandidateStore(worker).next(null), null);
  await admin.query(
    "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
});

test('blacklist deletion and author execution keep independent results and send each plan only once', async () => {
  for (const action of ['DELETE_TIMEOUT', 'DELETE_BAN']) {
    const f = await dispatchFixture({ action });
    const sends = { message: 0, author: 0 };
    const tokens = {
      async accessToken(accountId) {
        assert.equal(accountId, f.accountId);
        return 'test-access';
      },
    };
    const deletion = new DeleteExecutor(
      new DeleteExecutionStore(worker),
      new DeleteEligibilityStore(worker, () => true),
      tokens,
      {
        async deleteMessage(input) {
          sends.message++;
          assert.equal(input.externalMessageId, f.externalMessageId);
          assert.equal(
            (
              await admin.query(
                `SELECT a.status FROM youtube_delete_attempts a
          JOIN youtube_delete_executions e ON e.id = a.execution_id WHERE e.plan_id = $1`,
                [f.messagePlanId],
              )
            ).rows[0].status,
            'DISPATCHED',
          );
          return { status: 'REJECTED', http_status: 404, code: 'MESSAGE_NOT_FOUND' };
        },
      },
    );
    const author = new BanExecutor(
      new BanExecutionStore(worker),
      new BanEligibilityStore(worker, () => true),
      tokens,
      {
        async banUser(input) {
          sends.author++;
          assert.equal(input.authorChannelId, f.author);
          assert.equal(input.action, action === 'DELETE_TIMEOUT' ? 'TIMEOUT' : 'BAN');
          assert.equal(input.durationSeconds, action === 'DELETE_TIMEOUT' ? 60 : undefined);
          assert.equal(
            (
              await admin.query(
                `SELECT a.status FROM youtube_ban_attempts a
          JOIN youtube_ban_executions e ON e.id = a.execution_id WHERE e.plan_id = $1`,
                [f.authorPlanId],
              )
            ).rows[0].status,
            'DISPATCHED',
          );
          return { status: 'SUCCEEDED', http_status: 200, ban_id: 'test-confirmed-ban' };
        },
      },
      {
        async resolve() {
          return { status: 'RESOLVED', channelId: `UC${'b'.repeat(22)}` };
        },
      },
    );
    const input = (planId) => ({
      planId,
      channelId: f.channelId,
      sessionId: f.sessionId,
      ownerId: randomUUID(),
    });
    const settled = await Promise.allSettled([
      deletion.execute(input(f.messagePlanId)),
      deletion.execute(input(f.messagePlanId)),
      author.execute(input(f.authorPlanId)),
      author.execute(input(f.authorPlanId)),
    ]);
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    assert.deepEqual(sends, { message: 1, author: 1 });
    assert.equal(settled.filter((entry) => entry.value.status === 'RECORDED').length, 2);
    await deletion.execute(input(f.messagePlanId));
    await author.execute(input(f.authorPlanId));
    assert.deepEqual(sends, { message: 1, author: 1 });
    assert.equal(
      (
        await admin.query(
          `SELECT a.status FROM youtube_delete_attempts a JOIN youtube_delete_executions e
      ON e.id = a.execution_id WHERE e.plan_id = $1`,
          [f.messagePlanId],
        )
      ).rows[0].status,
      'REJECTED',
    );
    assert.equal(
      (
        await admin.query(
          `SELECT a.status FROM youtube_ban_attempts a JOIN youtube_ban_executions e
      ON e.id = a.execution_id WHERE e.plan_id = $1`,
          [f.authorPlanId],
        )
      ).rows[0].status,
      'SUCCEEDED',
    );
    await admin.query(
      "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
      [f.runId],
    );
  }
});

test('blacklist dispatch preserves action switches, current membership and stopped-run checks', async () => {
  const f = await dispatchFixture();
  const deletion = await new DeleteExecutionStore(worker).ensure(
    f.messagePlanId,
    f.channelId,
    f.sessionId,
  );
  const author = await new BanExecutionStore(worker).ensure(
    f.authorPlanId,
    f.channelId,
    f.sessionId,
  );
  assert.equal(await new DeleteEligibilityStore(worker, () => false).resolve(deletion), null);
  assert.equal(await new BanEligibilityStore(worker, () => false).resolve(author), null);
  await admin.query(
    "UPDATE channel_memberships SET role = 'OPERATOR' WHERE channel_id = $1 AND account_id = $2",
    [f.channelId, f.accountId],
  );
  assert.equal(await new DeleteEligibilityStore(worker, () => true).resolve(deletion), null);
  assert.equal(await new BanEligibilityStore(worker, () => true).resolve(author), null);
  await admin.query(
    "UPDATE channel_memberships SET role = 'OWNER' WHERE channel_id = $1 AND account_id = $2",
    [f.channelId, f.accountId],
  );
  await admin.query(
    "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
  assert.equal(await new DeleteEligibilityStore(worker, () => true).resolve(deletion), null);
  assert.equal(await new BanEligibilityStore(worker, () => true).resolve(author), null);
});

test('provenance rejects swapped plan slots and another channel or session', async () => {
  const f = await dispatchFixture();
  const provenance = new BlacklistDispatchProvenance(worker);
  assert.equal(await provenance.allows(f.messagePlanId, f.channelId, f.sessionId, 'message'), true);
  assert.equal(await provenance.allows(f.authorPlanId, f.channelId, f.sessionId, 'author'), true);
  assert.equal(await provenance.allows(f.messagePlanId, f.channelId, f.sessionId, 'author'), false);
  assert.equal(await provenance.allows(f.authorPlanId, f.channelId, f.sessionId, 'message'), false);
  assert.equal(
    await provenance.allows(f.messagePlanId, randomUUID(), f.sessionId, 'message'),
    false,
  );
  assert.equal(await provenance.allows(f.authorPlanId, f.channelId, randomUUID(), 'author'), false);
  await admin.query(
    'INSERT INTO channel_custom_blacklists(id, channel_id, revision, configuration, created_by) VALUES ($1, $2, 2, $3::jsonb, $4)',
    [
      randomUUID(),
      f.channelId,
      JSON.stringify({ schema_version: 1, enabled: false, rules: [] }),
      f.accountId,
    ],
  );
  assert.equal(await provenance.allows(f.messagePlanId, f.channelId, f.sessionId, 'message'), true);
  assert.equal(await provenance.allows(f.authorPlanId, f.channelId, f.sessionId, 'author'), true);
  await admin.query(
    "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
});

test('dispatch eligibility validates linked blacklist plans and blocks retired built-in actions', async () => {
  for (const staged of [true, false]) {
    const f = await fixture({ seedClassification: !staged });
    let ids;
    if (staged) {
      await classifyFixture(f);
      const decision = (
        await admin.query(
          'SELECT message_plan_id, author_plan_id FROM youtube_blacklist_decisions WHERE classification_id = $1',
          [f.classificationId],
        )
      ).rows[0];
      ids = [decision.message_plan_id, decision.author_plan_id];
    } else {
      ids = await transaction(worker, async (client) => {
        const plans = new ActionPlanStore();
        const saved = [];
        for (const [index, plan] of f.bundle.plans.entries()) {
          saved.push(
            (
              await plans.save(client, {
                ...plan,
                policy_version: `settings-run-${f.runId}-${index}`,
              })
            ).id,
          );
        }
        return saved;
      });
    }
    await admin.query(
      "UPDATE monitoring_runs SET status = 'RUNNING', started_at = clock_timestamp() WHERE id = $1",
      [f.runId],
    );
    await admin.query('INSERT INTO youtube_chat_checkpoints(session_id) VALUES ($1)', [
      f.sessionId,
    ]);
    await admin.query(
      `INSERT INTO google_credentials(account_id, access_token_ciphertext, refresh_token_ciphertext, expires_at, scopes)
      VALUES ($1, 'test-only-access', 'test-only-refresh', clock_timestamp() + interval '1 hour', 'https://www.googleapis.com/auth/youtube.force-ssl')`,
      [f.accountId],
    );
    const deletion = await new DeleteExecutionStore(worker).ensure(
      ids[0],
      f.channelId,
      f.sessionId,
    );
    const timeout = await new BanExecutionStore(worker).ensure(ids[1], f.channelId, f.sessionId);
    const expected = staged ? { accountId: f.accountId } : null;
    assert.deepEqual(
      await new DeleteEligibilityStore(worker, () => true).resolve(deletion),
      expected,
    );
    assert.deepEqual(await new BanEligibilityStore(worker, () => true).resolve(timeout), expected);
    await admin.query(
      "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
      [f.runId],
    );
  }
});

async function classifyFixture(
  f,
  store = createClassificationStore(),
  observation = f.observation,
) {
  const result = await transaction(worker, (client) => store.classify(client, observation));
  if (result.classificationId) f.classificationId = result.classificationId;
  return result;
}

test('a pending pre-settings built-in plan remains readable but cannot discover or dispatch', async () => {
  const f = await fixture({ action: 'DELETE' });
  const plan = await transaction(worker, (client) =>
    new ActionPlanStore().save(client, {
      ...f.bundle.plans[0],
      policy_version: 'actions-1',
    }),
  );
  await activateDispatch(f);
  const execution = await new DeleteExecutionStore(worker).ensure(
    plan.id,
    f.channelId,
    f.sessionId,
  );
  assert.equal(await new DeleteCandidateStore(worker).next(null), null);
  assert.equal(await new DeleteEligibilityStore(worker, () => true).resolve(execution), null);
  const retained = await admin.query(
    'SELECT policy_version, action FROM youtube_moderation_action_plans WHERE id=$1',
    [plan.id],
  );
  assert.deepEqual(retained.rows, [{ policy_version: 'actions-1', action: 'DELETE' }]);
  await admin.query(
    "UPDATE monitoring_runs SET status='STOPPED', finished_at=clock_timestamp() WHERE id=$1",
    [f.runId],
  );
});

test('competing pipeline classifications reuse one classification, audit and pair of plans', async () => {
  const f = await fixture({ seedClassification: false });
  const settled = await Promise.allSettled(Array.from({ length: 4 }, () => classifyFixture(f)));
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  assert.equal(new Set(settled.map((result) => result.value.classificationId)).size, 1);
  assert.deepEqual(await counts(f), { decisions: 1, plans: 2 });
});

test('database rejects blacklist reasons with inferred severity/category or an allow outcome', async () => {
  const f = await fixture({ seedClassification: false });
  for (const [outcome, category, severity, signals] of [
    ['ALLOW', null, null, []],
    ['REVIEW', null, null, []],
    ['ACTION_REQUIRED', 'SPAM', 1, []],
    ['ACTION_REQUIRED', null, 1, []],
    ['ACTION_REQUIRED', null, null, [{ rule_id: 'invented' }]],
  ]) {
    await assert.rejects(
      admin.query(
        `INSERT INTO youtube_chat_classifications(
      id, channel_id, session_id, observation_id, run_id, classifier_version, policy_version,
      outcome, primary_category, severity, reason_code, reason, signals)
      VALUES ($1, $2, $3, $4, $5, 'invalid-blacklist-fixture', 'policy-1', $6, $7, $8,
        'BLACKLIST_MATCH', 'Invalid blacklist classification.', $9::jsonb)`,
        [
          randomUUID(),
          f.channelId,
          f.sessionId,
          f.observationId,
          f.runId,
          outcome,
          category,
          severity,
          JSON.stringify(signals),
        ],
      ),
      { code: '23514' },
    );
  }
});

test('normal pipeline saves blacklist decisions and paired plans without a competing built-in plan', async () => {
  for (const action of ['DELETE', 'DELETE_TIMEOUT', 'DELETE_BAN']) {
    const f = await fixture({ action, text: 'abc idiot', seedClassification: false });
    const result = await classifyFixture(f);
    assert.equal(result.decision.outcome, 'ACTION_REQUIRED');
    assert.equal(result.decision.reason_code, 'BLACKLIST_MATCH');
    assert.equal(result.decision.primary_category, null);
    assert.equal(result.decision.severity, null);
    assert.deepEqual(result.decision.signals, []);
    const rows = (
      await admin.query(
        'SELECT bundle, message_plan_id, author_plan_id FROM youtube_blacklist_decisions WHERE classification_id = $1',
        [f.classificationId],
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bundle.selected_action, action);
    assert.ok(rows[0].message_plan_id);
    assert.equal(Boolean(rows[0].author_plan_id), action !== 'DELETE');
    assert.deepEqual(await counts(f), { decisions: 1, plans: action === 'DELETE' ? 1 : 2 });
    const replay = await classifyFixture(f);
    assert.equal(replay.classificationId, result.classificationId);
    assert.deepEqual(await counts(f), { decisions: 1, plans: action === 'DELETE' ? 1 : 2 });
  }
});

test('normal pipeline keeps unmatched/default policy planning and unavailable-author deletion', async () => {
  for (const options of [
    { text: 'Hello viewer' },
    { saved: false, text: 'Hello viewer' },
    { author: null },
  ]) {
    const f = await fixture({ ...options, seedClassification: false });
    const result = await classifyFixture(f);
    const bundle = (
      await admin.query(
        'SELECT bundle FROM youtube_blacklist_decisions WHERE classification_id = $1',
        [f.classificationId],
      )
    ).rows[0].bundle;
    assert.deepEqual(await counts(f), { decisions: 1, plans: 1 });
    if (options.author === null) {
      assert.equal(result.decision.reason_code, 'BLACKLIST_MATCH');
      assert.equal(bundle.author_action_status, 'TARGET_UNAVAILABLE');
      assert.equal(bundle.plans[0].action, 'DELETE');
    } else {
      assert.equal(result.decision.outcome, 'ALLOW');
      assert.deepEqual(bundle.plans, []);
      assert.equal(
        (
          await admin.query(
            'SELECT action FROM youtube_moderation_action_plans WHERE classification_id = $1',
            [f.classificationId],
          )
        ).rows[0].action,
        'NONE',
      );
    }
  }
});

test('pipeline replay retains original blacklist revision after another run captures disabled settings', async () => {
  const f = await fixture({ seedClassification: false });
  const original = await classifyFixture(f);
  const beforeReplay = (
    await admin.query(
      'SELECT id, bundle, message_plan_id, author_plan_id FROM youtube_blacklist_decisions WHERE classification_id = $1',
      [f.classificationId],
    )
  ).rows[0];
  await admin.query(
    "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
  await admin.query(
    'INSERT INTO channel_custom_blacklists(id, channel_id, revision, configuration, created_by) VALUES ($1, $2, 2, $3::jsonb, $4)',
    [
      randomUUID(),
      f.channelId,
      JSON.stringify({ schema_version: 1, enabled: false, rules: [] }),
      f.accountId,
    ],
  );
  const newRun = randomUUID();
  await admin.query(
    'INSERT INTO monitoring_runs(id, channel_id, session_id, requested_by_account_id, credential_account_id) VALUES ($1, $2, $3, $4, $4)',
    [newRun, f.channelId, f.sessionId, f.accountId],
  );
  const replay = await classifyFixture(f, createClassificationStore(), {
    ...f.observation,
    runId: newRun,
  });
  assert.equal(replay.classificationId, original.classificationId);
  assert.deepEqual(
    (
      await admin.query(
        'SELECT id, bundle, message_plan_id, author_plan_id FROM youtube_blacklist_decisions WHERE classification_id = $1',
        [f.classificationId],
      )
    ).rows[0],
    beforeReplay,
  );
});

test('outer ingestion rollback removes classification, decision and paired plans', async () => {
  const f = await fixture({ seedClassification: false });
  await assert.rejects(
    transaction(worker, async (client) => {
      const result = await createClassificationStore().classify(client, f.observation);
      f.classificationId = result.classificationId;
      assert.deepEqual(await counts(f, client), { decisions: 1, plans: 2 });
      throw new Error('Rollback ingestion');
    }),
    /Rollback ingestion/,
  );
  assert.deepEqual(await counts(f), { decisions: 0, plans: 0 });
  assert.equal(
    (
      await admin.query('SELECT id FROM youtube_chat_classifications WHERE observation_id = $1', [
        f.observationId,
      ])
    ).rowCount,
    0,
  );
});

test('linked blacklist message and author plans are independently discoverable', async () => {
  const f = await fixture({ seedClassification: false });
  await classifyFixture(f);
  await admin.query(
    "UPDATE monitoring_runs SET status = 'RUNNING', started_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
  const decision = (
    await admin.query(
      'SELECT message_plan_id, author_plan_id FROM youtube_blacklist_decisions WHERE classification_id = $1',
      [f.classificationId],
    )
  ).rows[0];
  assert.deepEqual(await new DeleteCandidateStore(worker).next(null), {
    planId: decision.message_plan_id,
    channelId: f.channelId,
    sessionId: f.sessionId,
  });
  assert.deepEqual(await new BanCandidateStore(worker).next(null), {
    planId: decision.author_plan_id,
    channelId: f.channelId,
    sessionId: f.sessionId,
  });
  await admin.query(
    "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
});

test('pipeline skips moderation events with display text and rejects missing run snapshots', async () => {
  const event = await fixture({ eventType: 'userBannedEvent', seedClassification: false });
  assert.deepEqual(await classifyFixture(event), { classified: false });
  const f = await fixture({ seedClassification: false });
  await assert.rejects(
    classifyFixture(f, createClassificationStore(), { ...f.observation, runId: randomUUID() }),
    /no unique blacklist snapshot/,
  );
  assert.equal(
    (
      await admin.query('SELECT id FROM youtube_chat_classifications WHERE observation_id = $1', [
        f.observationId,
      ])
    ).rowCount,
    0,
  );
});

const schema = `blacklist_plans_${randomUUID().replaceAll('-', '')}`;
const workerRole = `bl_worker_${randomUUID().replaceAll('-', '')}`;
const apiRole = `bl_api_${randomUUID().replaceAll('-', '')}`;
let admin, worker, api, migrate;
let schemaCreated = false,
  workerCreated = false,
  apiCreated = false;
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('Set TEST_DATABASE_URL to an admin-capable local test database.');
  }
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
      connectionTimeoutMillis: 3000,
      statement_timeout: 10000,
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

async function fixture({
  action = 'DELETE_TIMEOUT',
  author = `UC${'a'.repeat(22)}`,
  text = 'abc',
  saved = true,
  eventType = 'textMessageEvent',
  seedClassification = true,
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
  await admin.query('INSERT INTO accounts(id, display_name) VALUES ($1, $2)', [
    f.accountId,
    'Blacklist plan owner',
  ]);
  await admin.query('INSERT INTO channels(id, display_name) VALUES ($1, $2)', [
    f.channelId,
    'Blacklist plan channel',
  ]);
  await admin.query(
    "INSERT INTO channel_memberships(channel_id, account_id, role) VALUES ($1, $2, 'OWNER')",
    [f.channelId, f.accountId],
  );
  await admin.query(
    'INSERT INTO youtube_channels(channel_id, youtube_channel_id) VALUES ($1, $2)',
    [f.channelId, `channel-${randomUUID()}`],
  );
  await admin.query(
    "INSERT INTO stream_sessions(id, channel_id, label, source) VALUES ($1, $2, $3, 'YOUTUBE')",
    [f.sessionId, f.channelId, 'Blacklist plan test'],
  );
  await admin.query(
    'INSERT INTO youtube_broadcasts(session_id, channel_id, youtube_broadcast_id, live_chat_id) VALUES ($1, $2, $3, $4)',
    [f.sessionId, f.channelId, `broadcast-${randomUUID()}`, `chat-${randomUUID()}`],
  );
  if (saved)
    await admin.query(
      'INSERT INTO channel_custom_blacklists(id, channel_id, revision, configuration, created_by) VALUES ($1, $2, 1, $3::jsonb, $4)',
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
              match_type: 'WORD',
              pattern: 'abc',
              action,
              ...(action === 'DELETE_TIMEOUT' ? { duration_seconds: 60 } : {}),
            },
          ],
        }),
        f.accountId,
      ],
    );
  await admin.query(
    'INSERT INTO monitoring_runs(id, channel_id, session_id, requested_by_account_id, credential_account_id) VALUES ($1, $2, $3, $4, $4)',
    [f.runId, f.channelId, f.sessionId, f.accountId],
  );
  const payload = {
    id: f.externalMessageId,
    snippet: { type: eventType, textMessageDetails: { messageText: text } },
    ...(author === null
      ? {}
      : { authorDetails: { channelId: author, displayName: 'Blacklist plan viewer' } }),
  };
  await admin.query(
    `INSERT INTO youtube_chat_observations(id, channel_id, session_id, first_observed_run_id,
    external_message_id, event_type, published_at, payload, payload_hash)
    VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(), $7::jsonb, $8)`,
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
  if (seedClassification)
    await admin.query(
      `INSERT INTO youtube_chat_classifications(id, channel_id, session_id, observation_id, run_id,
    classifier_version, policy_version, outcome, primary_category, severity, reason_code, reason, signals)
    VALUES ($1, $2, $3, $4, $5, 'fixture-1', 'policy-1', 'ALLOW', NULL, 0, 'NO_RULE_MATCH', 'Fixture baseline classification.', '[]'::jsonb)`,
      [f.classificationId, f.channelId, f.sessionId, f.observationId, f.runId],
    );
  const selected = (
    await admin.query(
      'SELECT run_id, channel_id, blacklist_id, blacklist_revision, configuration, source FROM monitoring_blacklist_snapshots WHERE run_id = $1',
      [f.runId],
    )
  ).rows[0];
  f.bundle = new BlacklistActionPlanner(selected).plan(
    {
      run_id: f.runId,
      channel_id: f.channelId,
      session_id: f.sessionId,
      classification_id: f.classificationId,
      external_message_id: f.externalMessageId,
      author_channel_id: author,
    },
    text,
  );
  f.observation = {
    channelId: f.channelId,
    sessionId: f.sessionId,
    runId: f.runId,
    observationId: f.observationId,
    externalMessageId: f.externalMessageId,
    publishedAt: '2026-10-04T00:00:00Z',
    payload,
  };
  return f;
}
function save(f, bundle = f.bundle, store = new BlacklistActionStore()) {
  return transaction(worker, (client) => store.save(client, bundle));
}
async function counts(f, connection = admin) {
  return (
    await connection.query(
      `SELECT
    (SELECT count(*)::int FROM youtube_blacklist_decisions WHERE classification_id = $1) AS decisions,
    (SELECT count(*)::int FROM youtube_moderation_action_plans WHERE classification_id = $1) AS plans`,
      [f.classificationId],
    )
  ).rows[0];
}

test('migration is repeatable and timeout/ban bundles persist linked independent plans under worker permissions', async () => {
  await migrate(admin);
  for (const action of ['DELETE_TIMEOUT', 'DELETE_BAN']) {
    const f = await fixture({ action });
    const stored = await save(f);
    assert.equal(stored.reused, false);
    assert.ok(stored.messagePlanId);
    assert.ok(stored.authorPlanId);
    assert.notEqual(stored.messagePlanId, stored.authorPlanId);
    assert.deepEqual(stored.bundle, f.bundle);
    assert.deepEqual(await counts(f), { decisions: 1, plans: 2 });
    const again = await save(f);
    assert.equal(again.reused, true);
    assert.equal(again.id, stored.id);
    assert.equal(again.messagePlanId, stored.messagePlanId);
    assert.equal(again.authorPlanId, stored.authorPlanId);
  }
});

test('competing writers reuse one decision and one pair of plans', async () => {
  const f = await fixture();
  const settled = await Promise.allSettled(Array.from({ length: 4 }, () => save(f)));
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  const results = settled.map((result) => result.value);
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(results.filter((result) => !result.reused).length, 1);
  assert.deepEqual(await counts(f), { decisions: 1, plans: 2 });
});

test('forged message/author targets and decisions fail before inserting any plans', async () => {
  const f = await fixture();
  for (const bundle of [
    {
      ...f.bundle,
      plans: [{ ...f.bundle.plans[0], external_message_id: 'other-message' }, f.bundle.plans[1]],
    },
    {
      ...f.bundle,
      plans: [
        f.bundle.plans[0],
        { ...f.bundle.plans[1], author_channel_id: `UC${'b'.repeat(22)}` },
      ],
    },
    {
      ...f.bundle,
      duration_seconds: 120,
      plans: [f.bundle.plans[0], { ...f.bundle.plans[1], duration_seconds: 120 }],
    },
    { ...f.bundle, blacklist_revision: 99 },
    { ...f.bundle, plans: [{ ...f.bundle.plans[0], reason: 'Forged reason.' }, f.bundle.plans[1]] },
  ])
    await assert.rejects(save(f, bundle), /does not match its captured policy/);
  assert.deepEqual(await counts(f), { decisions: 0, plans: 0 });
});

test('cross-channel classifications, substituted run scope and non-text observations are rejected', async () => {
  const f = await fixture();
  const other = await fixture();
  await assert.rejects(
    save(f, {
      ...f.bundle,
      classification_id: other.classificationId,
      plans: f.bundle.plans.map((plan) => ({ ...plan, classification_id: other.classificationId })),
    }),
    /no matching text observation/,
  );
  await assert.rejects(
    save(f, { ...f.bundle, run_id: other.runId }),
    /no matching text observation/,
  );
  const event = await fixture({ eventType: 'userBannedEvent' });
  await assert.rejects(save(event), /no matching text observation/);
  assert.deepEqual(await counts(f), { decisions: 0, plans: 0 });
  assert.deepEqual(await counts(event), { decisions: 0, plans: 0 });
});

test('unmatched and default policy decisions persist provenance without actionable plans', async () => {
  for (const options of [{ text: 'hello' }, { saved: false }]) {
    const f = await fixture(options);
    const stored = await save(f);
    assert.deepEqual(stored.bundle.plans, []);
    assert.equal(stored.messagePlanId, null);
    assert.equal(stored.authorPlanId, null);
    assert.deepEqual(await counts(f), { decisions: 1, plans: 0 });
  }
});

test('missing author identity preserves deletion with explicit unavailable-target provenance', async () => {
  const f = await fixture({ author: null });
  const stored = await save(f);
  assert.equal(stored.bundle.author_action_status, 'TARGET_UNAVAILABLE');
  assert.ok(stored.messagePlanId);
  assert.equal(stored.authorPlanId, null);
  assert.deepEqual(await counts(f), { decisions: 1, plans: 1 });
});

test('failure on the author plan rolls back the message plan even if the outer transaction catches it', async () => {
  const f = await fixture();
  const real = new ActionPlanStore();
  let calls = 0;
  const store = new BlacklistActionStore({
    async save(client, plan) {
      calls++;
      if (calls === 2) throw new Error('Injected author plan failure');
      return real.save(client, plan);
    },
  });
  await transaction(worker, async (client) => {
    await assert.rejects(store.save(client, f.bundle), /Injected author plan failure/);
    assert.deepEqual(await counts(f, client), { decisions: 0, plans: 0 });
  });
  assert.deepEqual(await counts(f), { decisions: 0, plans: 0 });
});

test('caller rollback removes all newly saved decision and plan rows', async () => {
  const f = await fixture();
  await assert.rejects(
    transaction(worker, async (client) => {
      await new BlacklistActionStore().save(client, f.bundle);
      assert.deepEqual(await counts(f, client), { decisions: 1, plans: 2 });
      throw new Error('Rollback after bundle');
    }),
    /Rollback after bundle/,
  );
  assert.deepEqual(await counts(f), { decisions: 0, plans: 0 });
});

test('failure linking the final decision rolls back newly saved message plans', async () => {
  const f = await fixture();
  const real = new ActionPlanStore();
  const store = new BlacklistActionStore({
    async save(client, plan) {
      if (plan.action === 'TIMEOUT') return { id: randomUUID(), reused: false, plan };
      return real.save(client, plan);
    },
  });
  await transaction(worker, async (client) => {
    await assert.rejects(store.save(client, f.bundle), { code: '23514' });
    assert.deepEqual(await counts(f, client), { decisions: 0, plans: 0 });
  });
});

test('save without an explicit transaction fails before any writes', async () => {
  const f = await fixture();
  await assert.rejects(new BlacklistActionStore().save(worker, f.bundle), { code: '25P01' });
  assert.deepEqual(await counts(f), { decisions: 0, plans: 0 });
});

test('new channel configuration and run do not alter replay of the original captured decision', async () => {
  const f = await fixture();
  const original = await save(f);
  await admin.query(
    "UPDATE monitoring_runs SET status = 'STOPPED', finished_at = clock_timestamp() WHERE id = $1",
    [f.runId],
  );
  await admin.query(
    'INSERT INTO channel_custom_blacklists(id, channel_id, revision, configuration, created_by) VALUES ($1, $2, 2, $3::jsonb, $4)',
    [
      randomUUID(),
      f.channelId,
      JSON.stringify({ schema_version: 1, enabled: false, rules: [] }),
      f.accountId,
    ],
  );
  const newRun = randomUUID();
  await admin.query(
    'INSERT INTO monitoring_runs(id, channel_id, session_id, requested_by_account_id, credential_account_id) VALUES ($1, $2, $3, $4, $4)',
    [newRun, f.channelId, f.sessionId, f.accountId],
  );
  const replay = await save(f);
  assert.equal(replay.id, original.id);
  assert.deepEqual(replay.bundle, original.bundle);
  await assert.rejects(save(f, { ...f.bundle, run_id: newRun }), /no matching text observation/);
});

test('database guards require complete scoped slots and immutable decisions with restricted runtime permissions', async () => {
  const f = await fixture();
  const stored = await save(f);
  assert.equal(
    (await api.query('SELECT id FROM youtube_blacklist_decisions WHERE id = $1', [stored.id]))
      .rowCount,
    1,
  );
  for (const connection of [worker, api]) {
    await assert.rejects(
      connection.query('UPDATE youtube_blacklist_decisions SET bundle = bundle WHERE id = $1', [
        stored.id,
      ]),
      { code: '42501' },
    );
    await assert.rejects(
      connection.query('DELETE FROM youtube_blacklist_decisions WHERE id = $1', [stored.id]),
      { code: '42501' },
    );
    await assert.rejects(connection.query('TRUNCATE youtube_blacklist_decisions'), {
      code: '42501',
    });
  }
  await assert.rejects(
    admin.query('UPDATE youtube_blacklist_decisions SET bundle = bundle WHERE id = $1', [
      stored.id,
    ]),
    { code: '23514' },
  );
  await assert.rejects(
    api.query(
      `INSERT INTO youtube_blacklist_decisions(id, channel_id, session_id, classification_id, run_id, policy_version, bundle)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        randomUUID(),
        f.channelId,
        f.sessionId,
        f.classificationId,
        f.runId,
        f.bundle.policy_version,
        JSON.stringify(f.bundle),
      ],
    ),
    { code: '42501' },
  );
  await assert.rejects(
    admin.query(
      `INSERT INTO youtube_blacklist_decisions(id, channel_id, session_id, classification_id, run_id, policy_version,
    bundle, message_plan_id, author_plan_id) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NULL)`,
      [
        randomUUID(),
        f.channelId,
        f.sessionId,
        f.classificationId,
        f.runId,
        f.bundle.policy_version,
        JSON.stringify(f.bundle),
        stored.messagePlanId,
      ],
    ),
    { code: '23514' },
  );
});
