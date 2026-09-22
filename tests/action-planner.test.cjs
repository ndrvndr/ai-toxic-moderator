const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { ActionPlanner } = source('packages/moderation-core/src/action-planner.ts');

const policy = {
  version: 'actions-1',
  delete_rules: [
    {
      rule_id: 'test.explicit-abuse',
      rule_version: '1',
      minimum_severity: 2,
    },
  ],
};

const context = {
  classification_id: '10000000-0000-4000-8000-000000000001',
  channel_id: '20000000-0000-4000-8000-000000000002',
  session_id: '30000000-0000-4000-8000-000000000003',
  external_message_id: 'message-1',
};

function makeSignal(overrides = {}) {
  return {
    rule_id: 'test.explicit-abuse',
    rule_version: '1',
    category: 'HARASSMENT',
    severity: 2,
    strength: 'STRONG',
    confidence: null,
    intent: 'DIRECT_INSULT',
    evidence: [
      {
        representation_type: 'RAW',
        matched_text: 'test',
        normalized_span: { start: 0, end: 4 },
        raw_span: { start: 0, end: 4 },
        mapping_quality: 'EXACT',
      },
    ],
    ...overrides,
  };
}

test('messages without signals produce no action', () => {
  const result = new ActionPlanner(policy).plan({
    ...context,
    signals: [],
  });

  assert.equal(result.action, 'NONE');
  assert.equal('external_message_id' in result, false);
});

test('an explicitly enabled strong rule plans deletion', () => {
  const result = new ActionPlanner(policy).plan({
    ...context,
    signals: [makeSignal()],
  });

  assert.equal(result.action, 'DELETE');
  assert.equal(result.external_message_id, context.external_message_id);
  assert.equal(result.classification_id, context.classification_id);
  assert.equal(result.policy_version, 'actions-1');
  assert.equal('status' in result, false);
});

test('ambiguous, unlisted, outdated and weak signals do not trigger deletion', () => {
  const planner = new ActionPlanner(policy);

  const excluded = [
    makeSignal({ strength: 'AMBIGUOUS', severity: 4 }),
    makeSignal({ rule_id: 'another-rule', severity: 4 }),
    makeSignal({ rule_version: '2', severity: 4 }),
    makeSignal({ severity: 1 }),
  ];

  for (const entry of excluded) {
    assert.equal(
      planner.plan({
        ...context,
        signals: [entry],
      }).action,
      'NONE',
    );
  }
});

test('an empty action policy disables automatic deletion', () => {
  const planner = new ActionPlanner({
    version: 'actions-disabled',
    delete_rules: [],
  });

  assert.equal(
    planner.plan({
      ...context,
      signals: [makeSignal({ severity: 4 })],
    }).action,
    'NONE',
  );
});

test('signal order does not change the selected action', () => {
  const planner = new ActionPlanner(policy);
  const signals = [makeSignal({ rule_id: 'unlisted-rule', severity: 4 }), makeSignal()];

  assert.deepEqual(
    planner.plan({ ...context, signals }),
    planner.plan({ ...context, signals: [...signals].reverse() }),
  );
});

test('invalid policy thresholds are rejected', () => {
  assert.throws(
    () =>
      new ActionPlanner({
        ...policy,
        delete_rules: [
          {
            ...policy.delete_rules[0],
            minimum_severity: 0,
          },
        ],
      }),
  );
});
