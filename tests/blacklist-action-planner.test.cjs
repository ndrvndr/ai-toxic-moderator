const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { BlacklistActionPlanner } = source(
  'packages/moderation-core/src/blacklist-action-planner.ts',
);
const { blacklistActionBundle, moderationActionPlan } = source('packages/contracts/src/index.ts');

const input = {
  classification_id: '10000000-0000-4000-8000-000000000001',
  channel_id: '20000000-0000-4000-8000-000000000002',
  session_id: '30000000-0000-4000-8000-000000000003',
  run_id: '40000000-0000-4000-8000-000000000004',
  external_message_id: 'message-1',
  author_channel_id: `UC${'a'.repeat(22)}`,
};
function rule(index, overrides = {}) {
  return {
    id: `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    enabled: true,
    match_type: 'WORD',
    pattern: 'abc',
    action: 'DELETE',
    ...overrides,
  };
}
function snapshot(rules = [rule(1)], overrides = {}) {
  return {
    run_id: input.run_id,
    channel_id: input.channel_id,
    blacklist_id: '60000000-0000-4000-8000-000000000006',
    blacklist_revision: 2,
    source: 'SAVED',
    configuration: { schema_version: 1, enabled: true, rules },
    ...overrides,
  };
}
const timeout = () =>
  new BlacklistActionPlanner(
    snapshot([
      rule(1, {
        action: 'DELETE_TIMEOUT',
        duration_seconds: 60,
      }),
    ]),
  ).plan(input, 'abc');

test('delete-only blacklist entries create only a message plan with captured provenance', () => {
  const bundle = new BlacklistActionPlanner(snapshot()).plan(input, 'ABC');
  assert.equal(bundle.plans.length, 1);
  assert.equal(bundle.plans[0].action, 'DELETE');
  assert.equal(bundle.plans[0].external_message_id, input.external_message_id);
  assert.equal(bundle.author_action_status, 'NOT_SELECTED');
  assert.equal(bundle.blacklist_revision, 2);
  assert.equal(bundle.run_id, input.run_id);
  assert.equal(bundle.selected_rule_id, rule(1).id);
  assert.deepEqual(bundle.matched_rule_ids, [rule(1).id]);
  assert.equal('status' in bundle.plans[0], false);
});

test('timeout entries create separate executor-compatible deletion and timeout plans', () => {
  const bundle = timeout();
  assert.equal(bundle.author_action_status, 'PLANNED');
  assert.deepEqual(
    bundle.plans.map((plan) => plan.action),
    ['DELETE', 'TIMEOUT'],
  );
  assert.equal(bundle.plans[1].author_channel_id, input.author_channel_id);
  assert.equal(bundle.plans[1].duration_seconds, 60);
  assert.equal(bundle.plans[0].policy_version, `${bundle.policy_version}:message`);
  assert.equal(bundle.plans[1].policy_version, `${bundle.policy_version}:author`);
  for (const plan of bundle.plans) assert.deepEqual(moderationActionPlan.parse(plan), plan);
});

test('ban entries retain deletion and create a ban without a duration', () => {
  const bundle = new BlacklistActionPlanner(snapshot([rule(1, { action: 'DELETE_BAN' })])).plan(
    input,
    'abc',
  );
  assert.deepEqual(
    bundle.plans.map((plan) => plan.action),
    ['DELETE', 'BAN'],
  );
  assert.equal(bundle.duration_seconds, null);
  assert.equal('duration_seconds' in bundle.plans[1], false);
});

test('an unavailable author does not suppress deletion or fabricate an author plan', () => {
  const planner = new BlacklistActionPlanner(
    snapshot([rule(1, { action: 'DELETE_TIMEOUT', duration_seconds: 60 })]),
  );
  for (const author of [null, '', 'unknown-author', ' UCaaaaaaaaaaaaaaaaaaaaaa', 'unverified']) {
    const bundle = planner.plan({ ...input, author_channel_id: author }, 'abc');
    assert.equal(bundle.author_action_status, 'TARGET_UNAVAILABLE');
    assert.deepEqual(
      bundle.plans.map((plan) => plan.action),
      ['DELETE'],
    );
    assert.equal(bundle.selected_action, 'DELETE_TIMEOUT');
    assert.equal(bundle.duration_seconds, 60);
  }
});

test('overlapping entries select ban ahead of timeout regardless of entry order', () => {
  const rules = [
    rule(1, { action: 'DELETE_TIMEOUT', duration_seconds: 300 }),
    rule(2, { match_type: 'PHRASE', pattern: 'abc def', action: 'DELETE_BAN' }),
  ];
  const first = new BlacklistActionPlanner(snapshot(rules)).plan(input, 'abc def');
  const second = new BlacklistActionPlanner(snapshot([...rules].reverse())).plan(input, 'abc def');
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.plans.map((plan) => plan.action),
    ['DELETE', 'BAN'],
  );
});

test('unmatched and disabled saved policies produce no blacklist plans', () => {
  const planner = new BlacklistActionPlanner(snapshot());
  const unmatched = planner.plan(input, 'hello');
  assert.deepEqual(unmatched.plans, []);
  assert.equal(unmatched.selected_action, null);
  assert.equal(unmatched.selected_rule_id, null);
  assert.equal(unmatched.author_action_status, 'NOT_SELECTED');
  const disabled = new BlacklistActionPlanner(
    snapshot([], {
      configuration: { schema_version: 1, enabled: false, rules: [rule(1)] },
    }),
  ).plan(input, 'abc');
  assert.deepEqual(disabled.plans, []);
});

test('default and legacy snapshots do not inherit a saved policy', () => {
  for (const source of ['DEFAULT', 'LEGACY']) {
    const bundle = new BlacklistActionPlanner(
      snapshot([], {
        source,
        blacklist_id: null,
        blacklist_revision: null,
        configuration: { schema_version: 1, enabled: false, rules: [] },
      }),
    ).plan(input, 'abc');
    assert.deepEqual(bundle.plans, []);
    assert.equal(bundle.source, source);
  }
});

test('replay returns the same policy slots and decisions and preserves opaque message IDs', () => {
  const planner = new BlacklistActionPlanner(snapshot());
  const replay = { ...input, external_message_id: ' opaque-message-id ' };
  assert.deepEqual(planner.plan(replay, 'abc'), planner.plan(replay, 'abc'));
  assert.equal(
    planner.plan(replay, 'abc').plans[0].external_message_id,
    replay.external_message_id,
  );
});

test('wrong run/channel and invalid or injected input are rejected before planning', () => {
  const planner = new BlacklistActionPlanner(snapshot());
  assert.throws(
    () => planner.plan({ ...input, run_id: input.session_id }, 'abc'),
    /does not belong/,
  );
  assert.throws(
    () => planner.plan({ ...input, channel_id: input.session_id }, 'abc'),
    /does not belong/,
  );
  assert.throws(() => planner.plan({ ...input, external_message_id: '' }, 'abc'));
  assert.throws(() => planner.plan({ ...input, selected_action: 'BAN' }, 'abc'));
  assert.throws(() => new BlacklistActionPlanner(snapshot([], { blacklist_revision: null })));
});

test('bundle contract rejects mismatched scopes, slots, duplicate actions and forged outcomes', () => {
  const bundle = timeout();
  const mutations = [
    { ...bundle, plans: [bundle.plans[0], bundle.plans[0]] },
    { ...bundle, plans: [...bundle.plans].reverse() },
    { ...bundle, plans: [bundle.plans[0]] },
    { ...bundle, plans: [bundle.plans[0], { ...bundle.plans[1], channel_id: input.session_id }] },
    {
      ...bundle,
      plans: [bundle.plans[0], { ...bundle.plans[1], policy_version: 'another-policy' }],
    },
    { ...bundle, plans: [bundle.plans[0], { ...bundle.plans[1], duration_seconds: 120 }] },
    {
      ...bundle,
      plans: [bundle.plans[0], { ...bundle.plans[1], author_channel_id: 'unknown-author' }],
    },
    { ...bundle, plans: [bundle.plans[0], { ...bundle.plans[1], status: 'SUCCEEDED' }] },
    { ...bundle, author_action_status: 'NOT_SELECTED' },
    { ...bundle, selected_action: 'DELETE_BAN' },
    { ...bundle, selected_rule_id: input.run_id },
    { ...bundle, matched_rule_ids: [rule(1).id, rule(1).id] },
    { ...bundle, source: 'LEGACY' },
  ];
  for (const invalid of mutations)
    assert.equal(blacklistActionBundle.safeParse(invalid).success, false);
});

test('bundle contract rejects plans without matches and inconsistent author target availability', () => {
  const unmatched = new BlacklistActionPlanner(snapshot()).plan(input, 'hello');
  assert.equal(
    blacklistActionBundle.safeParse({ ...unmatched, plans: timeout().plans }).success,
    false,
  );
  assert.equal(
    blacklistActionBundle.safeParse({ ...timeout(), author_action_status: 'TARGET_UNAVAILABLE' })
      .success,
    false,
  );
  assert.equal(
    blacklistActionBundle.safeParse({ ...timeout(), duration_seconds: null }).success,
    false,
  );
});
