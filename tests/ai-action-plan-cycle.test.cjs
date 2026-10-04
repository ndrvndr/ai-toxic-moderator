const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { AiActionPlanCycle, createAiActionPlanCycle } = source(
  'apps/worker/src/ingestion/ai-action-plan-cycle.ts',
);
const { aiDispatchAllowedSql, readAiActionEvidence } = source(
  'apps/worker/src/ingestion/ai-dispatch-provenance.ts',
);

const runId = '10000000-0000-4000-8000-000000000001';
const decisionId = '20000000-0000-4000-8000-000000000002';
const signal = () => new AbortController().signal;
function harness({ select, save, connect } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
    },
    release() {
      calls.push('release');
    },
  };
  const pool = {
    async query(sql, values) {
      calls.push('select');
      assert.deepEqual(values, [runId]);
      assert.ok(sql.includes("r.status='RUNNING'"));
      assert.ok(sql.includes("d.decision->>'reason_code'='THRESHOLD_MET'"));
      assert.ok(sql.includes("prior.policy_version NOT LIKE 'ai-%'"));
      return { rows: select ? await select() : [{ id: decisionId }] };
    },
    async connect() {
      calls.push('connect');
      if (connect) await connect();
      return client;
    },
  };
  const cycle = new AiActionPlanCycle(runId, pool, {
    async save(connection, id, run) {
      assert.equal(connection, client);
      assert.equal(id, decisionId);
      assert.equal(run, runId);
      calls.push('save');
      return save
        ? save()
        : [
            { id: 'message-plan', reused: false },
            { id: 'author-plan', reused: true },
          ];
    },
  });
  return { cycle, calls };
}

test('plan factory remains opt-in and scoped without starting inference or provider requests', () => {
  const fail = () => assert.fail('Construction cannot access the database.');
  assert.equal(createAiActionPlanCycle({ AI_SHADOW_ENABLED: false }, { query: fail }), undefined);
  assert.ok(
    createAiActionPlanCycle({ AI_SHADOW_ENABLED: true, AI_SHADOW_RUN_ID: runId }, { query: fail }),
  );
  assert.throws(() =>
    createAiActionPlanCycle({ AI_SHADOW_ENABLED: true, AI_SHADOW_RUN_ID: 'invalid' }, {}),
  );
});

test('plan materialization commits before reporting counts and never opens a provider call', async () => {
  const { cycle, calls } = harness();
  assert.deepEqual(await cycle.tick(signal()), {
    kind: 'PROCESSED',
    decision_id: decisionId,
    inserted: 1,
  });
  assert.deepEqual(calls, ['select', 'connect', 'BEGIN', 'save', 'COMMIT', 'release']);
});

test('an empty backlog stays idle and cancellation after selection skips persistence', async () => {
  const idle = harness({ select: () => [] });
  assert.deepEqual(await idle.cycle.tick(signal()), { kind: 'IDLE' });
  assert.deepEqual(idle.calls, ['select']);
  const controller = new AbortController();
  const cancelled = harness({
    select: () => {
      controller.abort();
      return [{ id: decisionId }];
    },
  });
  assert.deepEqual(await cancelled.cycle.tick(controller.signal), { kind: 'CANCELLED' });
  assert.deepEqual(cancelled.calls, ['select']);
});

test('connection cancellation releases the transaction without creating any slot', async () => {
  const controller = new AbortController();
  const { cycle, calls } = harness({ connect: () => controller.abort() });
  assert.equal((await cycle.tick(controller.signal)).kind, 'CANCELLED');
  assert.deepEqual(calls, ['select', 'connect', 'BEGIN', 'COMMIT', 'release']);
});

test('failed materialization rolls back and releases busy state for recovery', async () => {
  let attempts = 0;
  const { cycle, calls } = harness({
    save: () => {
      if (++attempts === 1) throw new Error('fixture failure');
      return [];
    },
  });
  await assert.rejects(cycle.tick(signal()), /fixture failure/);
  assert.deepEqual(calls, ['select', 'connect', 'BEGIN', 'save', 'ROLLBACK', 'release']);
  assert.equal((await cycle.tick(signal())).inserted, 0);
});

test('overlapping ticks cannot materialize the same audit in this coordinator', async () => {
  let release;
  const { cycle } = harness({
    select: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = cycle.tick(signal());
  assert.equal((await cycle.tick(signal())).kind, 'BUSY');
  release([{ id: decisionId }]);
  assert.equal((await pending).kind, 'PROCESSED');
});

test('AI SQL gates reserve all ai-prefixed policies and require immutable model and run provenance', () => {
  for (const slot of ['message', 'author']) {
    const sql = aiDispatchAllowedSql(slot);
    assert.ok(sql.includes("p.policy_version NOT LIKE 'ai-%'"));
    assert.ok(sql.includes(`|| ':${slot}'`));
    assert.ok(sql.includes("captured.configuration->'automatic_actions_enabled'='true'::jsonb"));
    assert.ok(sql.includes("m.status='SUCCEEDED' AND NOT m.truncated"));
    assert.ok(sql.includes('d.classification_id=c.id'));
    assert.ok(sql.includes('o.first_observed_run_id=r.id'));
    assert.ok(sql.includes('prior_c.observation_id=o.id'));
  }
});

test('missing or malformed authoritative evidence never validates a plan', async () => {
  for (const rows of [[], [{ record: {} }], [{ record: {}, raw_text: 'hello' }]]) {
    assert.equal(
      await readAiActionEvidence(
        {
          async query() {
            return { rows };
          },
        },
        decisionId,
        runId,
      ),
      null,
    );
  }
});
