const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const api = await import('../scripts/ai-policy-evaluation.mjs');
  const cases = [0.49999, 0.5, 0.57, 0.9].map((score, index) => ({
    id: `case-${index}`,
    text: `example ${index}`,
    proposed_interpretation: index === 1 ? 'CLEAR' : 'ABUSIVE',
  }));
  const report = {
    model_id: 'fixture/model',
    revision: 'a'.repeat(40),
    variant: 'INT8',
    count: 4,
    results: cases.map((item, i) => ({
      ...item,
      rating: 2,
      severity_score: [0.49999, 0.5, 0.57, 0.9][i],
      truncated: false,
      inference_ms: 1,
    })),
  };
  return { ...api, cases, report };
}

test('the real planner chooses the highest tier at exact boundaries and also deletes on author actions', async () => {
  const { evaluatePolicy, policies, report, cases } = await fixture();
  const result = evaluatePolicy(report, cases, policies[0]);
  assert.deepEqual(
    result.rows.map((row) => row.tier),
    [null, 'DELETE', 'TIMEOUT', 'BAN'],
  );
  assert.deepEqual(
    result.rows.map((row) => row.actions),
    [[], ['DELETE'], ['DELETE', 'TIMEOUT'], ['DELETE', 'BAN']],
  );
  assert.equal(result.rows[1].interpretation, 'CLEAR');
});

test('observation-only policies and truncated output never produce action plans', async () => {
  const { evaluatePolicy, policies, report, cases } = await fixture();
  assert.ok(
    evaluatePolicy(report, cases, policies[2]).rows.every((row) => row.actions.length === 0),
  );
  report.results[3].truncated = true;
  const row = evaluatePolicy(report, cases, policies[0]).rows[3];
  assert.equal(row.reason, 'INPUT_TRUNCATED');
  assert.deepEqual(row.actions, []);
});

test('changed labels, incomplete reports, unsupported variants and unordered tiers are rejected', async () => {
  const { evaluatePolicy, policies, report, cases } = await fixture();
  assert.throws(() => evaluatePolicy(report, cases, { ...policies[0], timeout: 0.4 }));
  assert.throws(() => evaluatePolicy({ ...report, variant: 'FP32' }, cases, policies[0]));
  assert.throws(() => evaluatePolicy({ ...report, count: 3 }, cases, policies[0]), /exactly/);
  assert.throws(
    () =>
      evaluatePolicy(
        report,
        [{ ...cases[0], proposed_interpretation: 'CLEAR' }, ...cases.slice(1)],
        policies[0],
      ),
    /differs/,
  );
});
