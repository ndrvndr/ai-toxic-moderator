const { test } = require('node:test');
const assert = require('node:assert/strict');
const { source } = require('./helpers/source.cjs');

const { RuleDetectionEngine } = source('packages/moderation-core/src/index.ts');

function message(rawText) {
  return {
    external_message_id: 'message-1',
    author_external_id: 'author-1',
    author_display_name: 'Test viewer',
    raw_text: rawText,
    published_at: '2026-09-20T00:00:00.000Z',
  };
}

const rules = [
  {
    id: 'test.harassment',
    version: '1',
    category: 'HARASSMENT',
    severity: 3,
    strength: 'STRONG',
    intent: 'DIRECT_INSULT',
    pattern: /\btoxicword\b/giu,
  },
  {
    id: 'test.spam',
    version: '1',
    category: 'SPAM',
    severity: 1,
    strength: 'AMBIGUOUS',
    intent: 'REPEATED_PROMOTION',
    pattern: /\bpromo123\b/giu,
  },
];

test('safe text produces no signals', async () => {
  const engine = new RuleDetectionEngine(rules);

  assert.deepEqual(await engine.detect(message('Welcome to the livestream.')), []);
});

test('matching text produces exact evidence spans', async () => {
  const engine = new RuleDetectionEngine(rules);
  const [result] = await engine.detect(message('This is TOXICWORD.'));

  assert.equal(result.rule_id, 'test.harassment');
  assert.equal(result.category, 'HARASSMENT');
  assert.equal(result.severity, 3);
  assert.equal(result.evidence[0].matched_text, 'TOXICWORD');
  assert.deepEqual(result.evidence[0].raw_span, {
    start: 8,
    end: 17,
  });
});

test('multiple signals are ordered by severity and rule ID', async () => {
  const engine = new RuleDetectionEngine(rules);

  const results = await engine.detect(message('promo123 toxicword'));

  assert.deepEqual(
    results.map((result) => result.rule_id),
    ['test.harassment', 'test.spam'],
  );
});

test('word-boundary rules do not match larger words', async () => {
  const engine = new RuleDetectionEngine(rules);

  assert.deepEqual(await engine.detect(message('toxicwording')), []);
});

test('global regular expressions can be reused safely', async () => {
  const engine = new RuleDetectionEngine(rules);

  const first = await engine.detect(message('toxicword'));
  const second = await engine.detect(message('toxicword'));

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
});

test('invalid input is rejected before detection', async () => {
  const engine = new RuleDetectionEngine(rules);

  await assert.rejects(
    engine.detect({
      ...message('toxicword'),
      raw_text: '',
    }),
  );
});
