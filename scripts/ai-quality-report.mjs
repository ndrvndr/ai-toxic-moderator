import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const thresholds = [0.35, 0.4, 0.45, 0.5, 0.55, 0.56, 0.6, 0.65, 0.75, 0.9];
const interpretations = new Set(['CLEAR', 'ABUSIVE', 'THREAT', 'AMBIGUOUS', 'OUTSIDE_SCOPE']);

export function analyze(report, cases) {
  if (!Array.isArray(cases) || !cases.length || !Array.isArray(report?.results))
    throw new Error('A nonempty case list and inference report are required.');
  if (!/^[a-f0-9]{40}$/.test(report.revision) || typeof report.model_id !== 'string')
    throw new Error('Model provenance is missing or invalid.');
  const expected = new Map();
  for (const item of cases) {
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      expected.has(item.id) ||
      typeof item.text !== 'string' ||
      !interpretations.has(item.proposed_interpretation)
    )
      throw new Error('Invalid or duplicate case identity or interpretation.');
    expected.set(item.id, item);
  }
  if (report.count !== cases.length || report.results.length !== cases.length)
    throw new Error('Report must contain exactly the provided cases.');
  const seen = new Set();
  const rows = report.results.map((result) => {
    const item = expected.get(result.id);
    if (
      !item ||
      seen.has(result.id) ||
      item.text !== result.text ||
      item.proposed_interpretation !== result.proposed_interpretation
    )
      throw new Error('Report case identity, text, or interpretation differs from the case list.');
    seen.add(result.id);
    if (
      !Number.isFinite(result.severity_score) ||
      result.severity_score < 0 ||
      result.severity_score > 1 ||
      typeof result.truncated !== 'boolean' ||
      !Number.isFinite(result.inference_ms) ||
      result.inference_ms < 0 ||
      !Number.isInteger(result.rating) ||
      result.rating < 0 ||
      result.rating > 4
    )
      throw new Error('Invalid inference score, rating, truncation, or timing.');
    return { ...item, ...result };
  });
  const eligible = rows.filter((row) => !row.truncated);
  const clear = eligible.filter((row) => row.proposed_interpretation === 'CLEAR');
  const abusive = eligible.filter((row) => row.proposed_interpretation === 'ABUSIVE');
  const sweep = thresholds.map((threshold) => {
    const falsePositives = clear.filter((row) => row.severity_score >= threshold);
    const truePositives = abusive.filter((row) => row.severity_score >= threshold);
    const falseNegatives = abusive.filter((row) => row.severity_score < threshold);
    return {
      threshold,
      falsePositives,
      truePositives,
      falseNegatives,
      clearCount: clear.length,
      abusiveCount: abusive.length,
      precision:
        truePositives.length + falsePositives.length === 0
          ? null
          : truePositives.length / (truePositives.length + falsePositives.length),
      recall: abusive.length === 0 ? null : truePositives.length / abusive.length,
    };
  });
  return {
    rows,
    sweep,
    truncated: rows.length - eligible.length,
    casesHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
  };
}

const cell = (value) =>
  String(value)
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/g, ' ');
const percent = (value) => (value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`);

export function renderReport(report, analysis) {
  const times = analysis.rows.map((row) => row.inference_ms).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const median = times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2;
  const lines = [
    '# Portfolio AI quality results',
    '',
    `Model: ${cell(report.model_id)}. Revision: \`${report.revision}\`. Variant: ${cell(report.variant)}. Node: ${cell(report.runtime)}.`,
    '',
    `Cases: ${analysis.rows.length}. Truncated and excluded from threshold counts: ${analysis.truncated}. Case-list SHA-256: \`${analysis.casesHash}\`.`,
    '',
    'Interpretations remain proposed author labels, reviewed for the intended message meaning. No independent annotator or held-out dataset was used. Threats, ambiguous messages, and out-of-scope concerns are excluded from the CLEAR/ABUSIVE metrics and shown separately below. These curated counts are not production accuracy estimates.',
    '',
    '## Single-threshold comparison',
    '',
    'Selection uses the full stored score >= threshold, not the rounded display value. Each row compares one severity cutoff; it does not execute plans or simulate provider eligibility, run state, blacklist precedence, or author protection. Truncated inputs are excluded, matching the planner guard.',
    '',
    '| Threshold | Clear selected / clear total | Abusive selected / abusive total | Abusive missed | Precision | Recall |',
    '| --- | --- | --- | --- | --- | --- |',
    ...analysis.sweep.map(
      (row) =>
        `| ${row.threshold.toFixed(2)} | ${row.falsePositives.length}/${row.clearCount} | ${row.truePositives.length}/${row.abusiveCount} | ${row.falseNegatives.length} | ${percent(row.precision)} | ${percent(row.recall)} |`,
    ),
    '',
    '## Error examples',
    '',
  ];
  for (const row of analysis.sweep.filter((entry) => [0.5, 0.56, 0.6].includes(entry.threshold))) {
    lines.push(
      `### Threshold ${row.threshold.toFixed(2)}`,
      '',
      `Clear messages selected: ${row.falsePositives.map((item) => item.id).join(', ') || 'none'}.`,
      '',
      `Abusive messages missed: ${row.falseNegatives.map((item) => item.id).join(', ') || 'none'}.`,
      '',
    );
  }
  lines.push(
    '## All examples',
    '',
    '| Case | Proposed interpretation | Original text | Rating | Expected severity | Truncated |',
    '| --- | --- | --- | --- | --- | --- |',
    ...analysis.rows.map(
      (row) =>
        `| ${cell(row.id)} | ${cell(row.proposed_interpretation)} | ${cell(row.text)} | ${row.rating} | ${row.severity_score.toFixed(4)} | ${row.truncated} |`,
    ),
    '',
    '## Runtime observation',
    '',
    `Inference time: min ${times[0].toFixed(1)} ms, median ${median.toFixed(1)} ms, max ${times.at(-1).toFixed(1)} ms. All examples, including the first inference, are included. Hardware and concurrent load were not recorded; these timings are not a throughput benchmark.`,
    '',
    '## Decision',
    '',
    'No enforcement threshold is endorsed or automatically applied. Safe anti-harassment text overlaps with direct insults. A cutoff that avoids those safe examples misses other abusive examples. Threat results do not establish a distinct threat detector; spam, gambling promotion, and scams require independent policy.',
    '',
    'The portfolio can demonstrate the configurable AI planning and execution path with an explicitly scoped test account. It must not describe this model/sample as sufficient evidence for reliably replacing human moderation or safely issuing permanent bans. Model ratings and expected severity are not calibrated violation probabilities.',
    '',
    'The existing highest-enabled-tier policy still applies in the application: Ban takes precedence over Timeout, then Delete. Selected Timeout/Ban plans can also delete the triggering message. This report changes no settings, rules, plans, or executor switches.',
    '',
  );
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2])
      throw new Error('Usage: node scripts/ai-quality-report.mjs results.json [cases.json]');
    const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const cases = JSON.parse(
      await readFile(
        process.argv[3] ?? new URL('./ai-prototype-cases.json', import.meta.url),
        'utf8',
      ),
    );
    console.log(renderReport(report, analyze(report, cases)));
  } catch (error) {
    console.error('AI quality report failed:', error.message);
    process.exitCode = 1;
  }
}
