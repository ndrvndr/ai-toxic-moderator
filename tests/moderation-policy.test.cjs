const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { ModerationPolicy } = source('packages/moderation-core/src/policy-evaluator.ts');

function signal(overrides = {}) {
  return {
    rule_id: 'rule.default',
    rule_version: '1',
    category: 'HARASSMENT',
    severity: 2,
    strength: 'STRONG',
    confidence: null,
    intent: 'DIRECT_INSULT',
    evidence: [
      {
        representation_type: 'RAW',
        matched_text: 'toxicword',
        normalized_span: { start: 0, end: 9 },
        raw_span: { start: 0, end: 9 },
        mapping_quality: 'EXACT',
      },
    ],
    ...overrides,
  };
}

test('messages without signals are allowed', () => {
  const result = new ModerationPolicy().evaluate([]);

  assert.deepEqual(result, {
    outcome: 'ALLOW',
    primary_category: null,
    severity: 0,
    reason_code: 'NO_RULE_MATCH',
    reason: 'No configured rule matched this message.',
    signals: [],
  });
});

test('matched signals require review', () => {
  const result = new ModerationPolicy().evaluate([signal()]);

  assert.equal(result.outcome, 'REVIEW');
  assert.equal(result.primary_category, 'HARASSMENT');
  assert.equal(result.severity, 2);
  assert.equal(result.reason_code, 'DIRECT_INSULT');
  assert.match(result.reason, /rule\.default/);
  assert.equal(result.signals.length, 1);
});

test('the highest severity signal becomes primary', () => {
  const result = new ModerationPolicy().evaluate([
    signal({
      rule_id: 'rule.low',
      severity: 1,
      category: 'SPAM',
      intent: 'REPEATED_PROMOTION',
    }),
    signal({
      rule_id: 'rule.high',
      severity: 4,
      category: 'THREAT',
      intent: 'DIRECT_THREAT',
    }),
  ]);

  assert.equal(result.primary_category, 'THREAT');
  assert.equal(result.severity, 4);
  assert.equal(result.reason_code, 'CONTEXT_REQUIRED');
});

test('equal severity signals use a stable rule ID order', () => {
  const result = new ModerationPolicy().evaluate([
    signal({
      rule_id: 'rule.zulu',
      severity: 3,
      category: 'SPAM',
    }),
    signal({
      rule_id: 'rule.alpha',
      severity: 3,
      category: 'SCAM',
    }),
  ]);

  assert.equal(result.primary_category, 'SCAM');
  assert.equal(result.signals[0].rule_id, 'rule.alpha');
});

test('invalid signals are rejected', () => {
  assert.throws(() =>
    new ModerationPolicy().evaluate([
      {
        rule_id: '',
        severity: 9,
      },
    ]),
  );
});
