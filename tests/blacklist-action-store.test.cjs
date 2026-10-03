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
