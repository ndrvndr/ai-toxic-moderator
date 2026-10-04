const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');
const { AiActionPlanner, BlacklistActionPlanner } = source('packages/moderation-core/src/index.ts');
const { moderationActionPlan } = source('packages/contracts/src/index.ts');

const input = {
  classification_id: '10000000-0000-4000-8000-00000000000a',
  channel_id: '20000000-0000-4000-8000-00000000000b',
  session_id: '30000000-0000-4000-8000-00000000000c',
  run_id: '40000000-0000-4000-8000-00000000000d',
  observation_id: '50000000-0000-4000-8000-00000000000e',
  external_message_id: ' opaque-message-id ',
  author_channel_id: `UC${'a'.repeat(22)}`,
};
const model = {
  model_id: 'laskar-ks/toxic-guardrail-minilm-id-en',
  model_revision: 'a'.repeat(40),
  model_variant: 'INT8',
  adapter_version: 'laskar-shadow-1',
};
function snapshot(overrides = {}) {
  return {
    source: 'SAVED',
    run_id: input.run_id,
    channel_id: input.channel_id,
    settings_id: '60000000-0000-4000-8000-00000000000f',
    settings_revision: 3,
    configuration: {
      schema_version: 1,
      automatic_actions_enabled: true,
      model: { ...model },
      score_metric: 'EXPECTED_SEVERITY',
      delete: { enabled: true, threshold: 0.4 },
      timeout: { enabled: true, threshold: 0.6, duration_seconds: 60 },
      ban: { enabled: true, threshold: 0.9 },
      ...overrides,
    },
  };
}
function output(score = 0.7, overrides = {}) {
  return {
    run_id: input.run_id,
    channel_id: input.channel_id,
    session_id: input.session_id,
    observation_id: input.observation_id,
    ...model,
    status: 'SUCCEEDED',
    rating: 2,
    severity_score: score,
    truncated: false,
    inference_ms: 6,
    error_code: null,
    ...overrides,
  };
}
function blacklist(context = input, match = false) {
  const { observation_id, ...blacklistInput } = context;
  return new BlacklistActionPlanner({
    run_id: context.run_id,
    channel_id: context.channel_id,
    source: match ? 'SAVED' : 'DEFAULT',
    blacklist_id: match ? '70000000-0000-4000-8000-000000000001' : null,
    blacklist_revision: match ? 1 : null,
    configuration: {
      schema_version: 1,
      enabled: match,
      rules: match
        ? [
            {
              id: '80000000-0000-4000-8000-000000000001',
              enabled: true,
              match_type: 'WORD',
              pattern: 'abc',
              action: 'DELETE_TIMEOUT',
              duration_seconds: 30,
            },
          ]
        : [],
    },
  }).plan(blacklistInput, 'abc');
}
const actions = (decision) => decision.plans.map((plan) => plan.action);
function plan(score, configuration = {}) {
  return new AiActionPlanner(snapshot(configuration)).plan(input, output(score), blacklist());
}

test('threshold boundaries use >= and choose the highest enabled tier', () => {
  for (const [score, expected] of [
    [0, []],
    [0.399999, []],
    [0.4, ['DELETE']],
    [0.599999, ['DELETE']],
    [0.6, ['DELETE', 'TIMEOUT']],
    [0.899999, ['DELETE', 'TIMEOUT']],
    [0.9, ['DELETE', 'BAN']],
    [1, ['DELETE', 'BAN']],
  ])
    assert.deepEqual(actions(plan(score)), expected, String(score));
  assert.equal(plan(0.1).reason_code, 'NO_THRESHOLD_MET');
  assert.equal(plan(0.6).selected_threshold, 0.6);
});

test('ordered thresholds can include zero and one without changing equality semantics', () => {
  const configuration = {
    delete: { enabled: true, threshold: 0 },
    timeout: { enabled: true, threshold: 0.5, duration_seconds: 60 },
    ban: { enabled: true, threshold: 1 },
  };
  assert.deepEqual(actions(plan(0, configuration)), ['DELETE']);
  assert.deepEqual(actions(plan(0.999999, configuration)), ['DELETE', 'TIMEOUT']);
  assert.deepEqual(actions(plan(1, configuration)), ['DELETE', 'BAN']);
});

test('all tier switch combinations preserve enabled precedence and author-action deletion', () => {
  for (let mask = 0; mask < 8; mask++) {
    const deletion = Boolean(mask & 1);
    const timeout = Boolean(mask & 2);
    const ban = Boolean(mask & 4);
    const decision = plan(1, {
      delete: { enabled: deletion, threshold: 0.4 },
      timeout: { enabled: timeout, threshold: 0.6, duration_seconds: 60 },
      ban: { enabled: ban, threshold: 0.9 },
    });
    assert.deepEqual(
      actions(decision),
      ban ? ['DELETE', 'BAN'] : timeout ? ['DELETE', 'TIMEOUT'] : deletion ? ['DELETE'] : [],
    );
  }
  assert.deepEqual(actions(plan(0.95, { ban: { enabled: false, threshold: 0.9 } })), [
    'DELETE',
    'TIMEOUT',
  ]);
  assert.deepEqual(actions(plan(0.5, { delete: { enabled: false, threshold: 0.4 } })), []);
});

test('expected severity determines actions independently of the discrete rating', () => {
  const planner = new AiActionPlanner(snapshot());
  assert.deepEqual(actions(planner.plan(input, output(0.2, { rating: 4 }), blacklist())), []);
  assert.deepEqual(actions(planner.plan(input, output(0.95, { rating: 0 }), blacklist())), [
    'DELETE',
    'BAN',
  ]);
});

test('blacklist takes priority even when AI output is absent or invalid', () => {
  const prior = blacklist(input, true);
  for (const result of [null, output(1), { status: 'invalid' }]) {
    const decision = new AiActionPlanner(snapshot()).plan(input, result, prior);
    assert.equal(decision.reason_code, 'BLACKLIST_MATCH');
    assert.equal(decision.model_output, null);
    assert.deepEqual(actions(decision), []);
    assert.deepEqual(
      prior.plans.map((item) => item.action),
      ['DELETE', 'TIMEOUT'],
    );
  }
});

test('a blacklist decision is required and must target this scope, message, and author', () => {
  const planner = new AiActionPlanner(snapshot());
  assert.throws(() => planner.plan(input, output(), null));
  for (const key of ['run_id', 'channel_id', 'session_id', 'classification_id']) {
    assert.throws(
      () => planner.plan(input, output(), blacklist({ ...input, [key]: input.observation_id })),
      /scope/,
    );
  }
  assert.throws(
    () =>
      planner.plan(input, output(), blacklist({ ...input, external_message_id: 'other' }, true)),
    /targets/,
  );
  assert.throws(
    () =>
      planner.plan(
        input,
        output(),
        blacklist({ ...input, author_channel_id: `UC${'b'.repeat(22)}` }, true),
      ),
    /targets/,
  );
});

test('default, legacy, and globally disabled policies never produce AI plans', () => {
  for (const origin of ['DEFAULT', 'LEGACY']) {
    const captured = {
      ...snapshot(),
      source: origin,
      settings_id: null,
      settings_revision: null,
      configuration: null,
    };
    const decision = new AiActionPlanner(captured).plan(input, output(1), blacklist());
    assert.equal(decision.reason_code, 'NO_SAVED_POLICY');
    assert.deepEqual(actions(decision), []);
  }
  const decision = plan(1, { automatic_actions_enabled: false });
  assert.equal(decision.reason_code, 'AI_DISABLED');
  assert.deepEqual(actions(decision), []);
});

test('missing and malformed outputs fail closed without coercing model scores', () => {
  const planner = new AiActionPlanner(snapshot());
  for (const result of [null, undefined]) {
    const decision = planner.plan(input, result, blacklist());
    assert.equal(decision.reason_code, 'OUTPUT_MISSING');
    assert.deepEqual(actions(decision), []);
  }
  for (const result of [
    {},
    output(NaN),
    output(Infinity),
    output(-1),
    output(1.1),
    output('0.9'),
    output(1, { action: 'BAN' }),
  ]) {
    const decision = planner.plan(input, result, blacklist());
    assert.equal(decision.reason_code, 'OUTPUT_INVALID');
    assert.deepEqual(actions(decision), []);
  }
});

test('inference errors and truncated successful output cannot authorize actions', () => {
  const planner = new AiActionPlanner(snapshot());
  for (const code of [
    'MODEL_UNAVAILABLE',
    'INFERENCE_FAILED',
    'INFERENCE_TIMEOUT',
    'INVALID_OUTPUT',
    'INPUT_TOO_LONG',
  ]) {
    const result = output(null, {
      status: 'ERROR',
      rating: null,
      truncated: null,
      inference_ms: null,
      error_code: code,
    });
    const decision = planner.plan(input, result, blacklist());
    assert.equal(decision.reason_code, 'INFERENCE_ERROR');
    assert.equal(decision.model_output.error_code, code);
    assert.deepEqual(actions(decision), []);
  }
  const truncated = planner.plan(input, output(1, { truncated: true }), blacklist());
  assert.equal(truncated.reason_code, 'INPUT_TRUNCATED');
  assert.deepEqual(actions(truncated), []);
});

test('every model identity field is pinned to the captured settings', () => {
  const planner = new AiActionPlanner(snapshot());
  for (const [key, value] of [
    ['model_id', 'other/model'],
    ['model_revision', 'b'.repeat(40)],
    ['adapter_version', 'other-adapter'],
  ]) {
    const decision = planner.plan(input, output(1, { [key]: value }), blacklist());
    assert.equal(decision.reason_code, 'MODEL_MISMATCH');
    assert.deepEqual(actions(decision), []);
  }
  const variant = planner.plan(input, output(1, { model_variant: 'FP32' }), blacklist());
  assert.equal(variant.reason_code, 'OUTPUT_INVALID');
  assert.deepEqual(actions(variant), []);
});

test('substituting any model scope or policy scope is rejected', () => {
  const planner = new AiActionPlanner(snapshot());
  for (const key of ['run_id', 'channel_id', 'session_id', 'observation_id']) {
    assert.throws(
      () => planner.plan(input, output(1, { [key]: input.classification_id }), blacklist()),
      /scope/,
    );
  }
  for (const key of ['run_id', 'channel_id']) {
    assert.throws(
      () =>
        new AiActionPlanner({ ...snapshot(), [key]: input.observation_id }).plan(
          input,
          output(),
          blacklist(),
        ),
      /does not belong/,
    );
  }
});

test('plans retain audit scope, revision, independent slots, and the captured timeout duration', () => {
  const decision = plan(0.7);
  assert.equal(decision.snapshot.settings_revision, 3);
  assert.equal(decision.selected_tier, 'TIMEOUT');
  assert.equal(decision.author_action_status, 'PLANNED');
  assert.equal(decision.plans[0].external_message_id, input.external_message_id);
  assert.equal(decision.plans[1].author_channel_id, input.author_channel_id);
  assert.equal(decision.plans[1].duration_seconds, 60);
  assert.equal(decision.plans[0].policy_version, `${decision.policy_version}:message`);
  assert.equal(decision.plans[1].policy_version, `${decision.policy_version}:author`);
  for (const item of decision.plans) {
    assert.deepEqual(moderationActionPlan.parse(item), item);
    for (const key of ['classification_id', 'channel_id', 'session_id'])
      assert.equal(item[key], input[key]);
    assert.equal('status' in item, false);
  }
  assert.equal('duration_seconds' in plan(1).plans[1], false);
});

test('unavailable authors retain deletion for timeout and ban without inventing a target', () => {
  for (const score of [0.7, 1]) {
    for (const author of [null, '', 'invalid-author', ` UC${'a'.repeat(22)}`]) {
      const context = { ...input, author_channel_id: author };
      const decision = new AiActionPlanner(snapshot()).plan(
        context,
        output(score),
        blacklist(context),
      );
      assert.equal(decision.author_action_status, 'TARGET_UNAVAILABLE');
      assert.deepEqual(actions(decision), ['DELETE']);
    }
  }
});

test('captured configuration and returned audit copies cannot change subsequent replay', () => {
  const captured = snapshot();
  const planner = new AiActionPlanner(captured);
  const expected = planner.plan(input, output(), blacklist());
  captured.configuration.timeout.threshold = 0.85;
  const returned = planner.plan(input, output(), blacklist());
  returned.snapshot.configuration.automatic_actions_enabled = false;
  returned.model_output.severity_score = 0;
  returned.plans.length = 0;
  assert.deepEqual(planner.plan(input, output(), blacklist()), expected);
});

test('scope comparison normalizes UUID casing while preserving opaque message targets', () => {
  const upper = { ...input };
  for (const key of ['classification_id', 'channel_id', 'session_id', 'run_id', 'observation_id'])
    upper[key] = input[key].toUpperCase();
  const decision = new AiActionPlanner({
    ...snapshot(),
    run_id: upper.run_id,
    channel_id: upper.channel_id,
  }).plan(
    upper,
    output(0.7, {
      run_id: upper.run_id,
      channel_id: upper.channel_id,
      session_id: upper.session_id,
      observation_id: upper.observation_id,
    }),
    blacklist(upper),
  );
  assert.deepEqual(decision.context, input);
  assert.equal(decision.plans[0].external_message_id, input.external_message_id);
});

test('invalid configuration and message contexts are rejected rather than supplied with defaults', () => {
  assert.throws(
    () =>
      new AiActionPlanner(
        snapshot({ timeout: { enabled: true, threshold: 0.4, duration_seconds: 60 } }),
      ),
  );
  const planner = new AiActionPlanner(snapshot());
  for (const context of [
    { ...input, external_message_id: ' ' },
    { ...input, observation_id: undefined },
    { ...input, action: 'BAN' },
  ]) {
    assert.throws(() => planner.plan(context, output(), blacklist()));
  }
});
