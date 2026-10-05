const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const api = await import('../scripts/ai-quality-report.mjs');
  const cases = ['CLEAR', 'ABUSIVE', 'THREAT', 'AMBIGUOUS', 'OUTSIDE_SCOPE'].map(
    (label, index) => ({
      id: `case-${index}`,
      text: `text-${index}`,
      proposed_interpretation: label,
    }),
  );
  const report = {
    model_id: 'fixture',
    revision: 'a'.repeat(40),
    count: 5,
    results: cases.map((item) => ({
      ...item,
      severity_score: 0.5,
      rating: 2,
      truncated: false,
      inference_ms: 1,
    })),
  };
  return { ...api, cases, report };
}

test('threshold boundaries use full scores and exclude nonbinary interpretations', async () => {
  const { analyze, report, cases } = await fixture();
  const atBoundary = analyze(report, cases).sweep.find((row) => row.threshold === 0.5);
  assert.equal(atBoundary.falsePositives.length, 1);
  assert.equal(atBoundary.truePositives.length, 1);
  assert.equal(atBoundary.precision, 0.5);
  report.results[0].severity_score = 0.49999;
  assert.equal(
    analyze(report, cases).sweep.find((row) => row.threshold === 0.5).falsePositives.length,
    0,
  );
});

test('truncated messages are excluded and no selections have undefined precision', async () => {
  const { analyze, report, cases } = await fixture();
  report.results[1].truncated = true;
  const analysis = analyze(report, cases);
  assert.equal(analysis.truncated, 1);
  const high = analysis.sweep.find((row) => row.threshold === 0.9);
  assert.equal(high.abusiveCount, 0);
  assert.equal(high.recall, null);
  assert.equal(high.precision, null);
});

test('partial and duplicate reports cannot silently change denominators', async () => {
  const { analyze, report, cases } = await fixture();
  report.results.pop();
  assert.throws(() => analyze(report, cases), /exactly/);
  report.results.push(report.results[0]);
  assert.throws(() => analyze(report, cases), /identity/);
});

test('changed text or interpretation requires a matching new inference report', async () => {
  const { analyze, report, cases } = await fixture();
  cases[0].text = 'edited';
  assert.throws(() => analyze(report, cases), /differs/);
  cases[0].text = report.results[0].text;
  cases[0].proposed_interpretation = 'ABUSIVE';
  assert.throws(() => analyze(report, cases), /differs/);
});

test('invalid scores and duplicate case IDs are rejected', async () => {
  const { analyze, report, cases } = await fixture();
  report.results[0].severity_score = NaN;
  assert.throws(() => analyze(report, cases), /score/);
  cases[1].id = cases[0].id;
  assert.throws(() => analyze(report, cases), /duplicate/);
});

test('markdown escapes table delimiters and retains zero-selection caveats', async () => {
  const { analyze, renderReport, report, cases } = await fixture();
  cases[0].text = report.results[0].text = 'a|b\nc';
  const output = renderReport(report, analyze(report, cases));
  assert.match(output, /a\\\|b c/);
  assert.match(output, /No enforcement threshold is endorsed/);
  assert.match(output, /N\/A/);
});
