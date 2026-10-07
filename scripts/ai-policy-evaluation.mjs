import { aiModerationSettingsConfiguration, aiShadowResult } from '@moderator/contracts';
import {
  AI_ACTION_PLANNER_VERSION,
  AiActionPlanner,
  BlacklistActionPlanner,
} from '@moderator/moderation-core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './ai-quality-report.mjs';

// In-sample demo comparisons, never production presets or automatic settings updates.
export const policies = [
  { name: 'Controlled all-tier demo', enabled: true, delete: 0.5, timeout: 0.57, ban: 0.9 },
  { name: 'Stricter comparison', enabled: true, delete: 0.56, timeout: 0.6, ban: 0.95 },
  { name: 'Observation only', enabled: false, delete: 0.5, timeout: 0.57, ban: 0.9 },
];

export function evaluatePolicy(report, cases, policy) {
  const analysis = analyze(report, cases);
  const model = {
    model_id: report.model_id,
    model_revision: report.revision,
    model_variant: report.variant,
    adapter_version: 'laskar-shadow-1',
  };
  const configuration = aiModerationSettingsConfiguration.parse({
    schema_version: 1,
    automatic_actions_enabled: policy.enabled,
    model,
    score_metric: 'EXPECTED_SEVERITY',
    delete: { enabled: true, threshold: policy.delete },
    timeout: { enabled: true, threshold: policy.timeout, duration_seconds: 30 },
    ban: { enabled: true, threshold: policy.ban },
  });
  const scope = {
    channel_id: '10000000-0000-4000-8000-000000000001',
    session_id: '10000000-0000-4000-8000-000000000002',
    run_id: '10000000-0000-4000-8000-000000000003',
  };
  const planner = new AiActionPlanner({
    source: 'SAVED',
    run_id: scope.run_id,
    channel_id: scope.channel_id,
    settings_id: '10000000-0000-4000-8000-000000000004',
    settings_revision: 1,
    configuration,
  });
  const blacklist = new BlacklistActionPlanner({
    run_id: scope.run_id,
    channel_id: scope.channel_id,
    source: 'DEFAULT',
    blacklist_id: null,
    blacklist_revision: null,
    configuration: { schema_version: 1, enabled: false, rules: [] },
  });
  const rows = analysis.rows.map((row, index) => {
    const context = {
      ...scope,
      classification_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      observation_id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      external_message_id: `local-evaluation:${row.id}`,
      author_channel_id: `UC${'a'.repeat(22)}`,
    };
    const output = aiShadowResult.parse({
      ...scope,
      observation_id: context.observation_id,
      ...model,
      status: 'SUCCEEDED',
      rating: row.rating,
      severity_score: row.severity_score,
      truncated: row.truncated,
      inference_ms: row.inference_ms,
      error_code: null,
    });
    const { observation_id, ...blacklistContext } = context;
    const decision = planner.plan(context, output, blacklist.plan(blacklistContext, row.text));
    return {
      id: row.id,
      interpretation: row.proposed_interpretation,
      score: row.severity_score,
      tier: decision.selected_tier,
      reason: decision.reason_code,
      actions: decision.plans.map((plan) => plan.action),
    };
  });
  return { configuration, rows, casesHash: analysis.casesHash };
}

const cell = (value) =>
  String(value)
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/g, ' ');

export function renderPolicyReport(report, cases) {
  const evaluations = policies.map((policy) => ({
    policy,
    ...evaluatePolicy(report, cases, policy),
  }));
  const lines = [
    '# Offline AI action-policy evaluation',
    '',
    `Model: ${cell(report.model_id)}. Revision: \`${report.revision}\`. Variant: ${cell(report.variant)}. Adapter: laskar-shadow-1. Planner: ${AI_ACTION_PLANNER_VERSION}. Runtime: ${cell(report.runtime)}.`,
    '',
    `Cases: ${cases.length}. Case-list SHA-256: \`${evaluations[0].casesHash}\`.`,
    '',
    'Uses the application AiActionPlanner and BlacklistActionPlanner in memory with synthetic identities and no blacklist matches. No database writes, YouTube requests, saved settings changes, or provider dispatch occur. A selected tier is a plan, not an executed action.',
    '',
    'Labels are the original proposed author interpretations. Policies were chosen with knowledge of earlier scores; this is not a held-out benchmark, an independent annotation study, or a calibrated safety guarantee. Truncated inputs are passed to the real planner and suppressed.',
    '',
    '## Compared policies',
    '',
    '| Policy | Automatic actions | Delete | Timeout | Ban | Timeout duration |',
    '| --- | --- | --- | --- | --- | --- |',
    ...policies.map(
      (p) =>
        `| ${p.name} | ${p.enabled} | ${p.delete.toFixed(2)} | ${p.timeout.toFixed(2)} | ${p.ban.toFixed(2)} | 30 seconds |`,
    ),
    '',
    '## Planning outcomes by interpretation',
    '',
    '| Policy | Interpretation | Cases | No tier | Delete tier | Timeout tier | Ban tier |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const evaluation of evaluations) {
    for (const label of ['CLEAR', 'ABUSIVE', 'THREAT', 'AMBIGUOUS', 'OUTSIDE_SCOPE']) {
      const rows = evaluation.rows.filter((row) => row.interpretation === label);
      const counts = [null, 'DELETE', 'TIMEOUT', 'BAN'].map(
        (tier) => rows.filter((row) => row.tier === tier).length,
      );
      lines.push(
        `| ${evaluation.policy.name} | ${label} | ${rows.length} | ${counts.join(' | ')} |`,
      );
    }
  }
  lines.push(
    '',
    'Timeout and Ban tiers also plan deletion of the triggering message. Tier counts are mutually exclusive; they are not provider success counts.',
    '',
    '## Per-example policy selection',
    '',
    '| Case | Interpretation | Expected severity | Demo tier | Stricter tier | Observation tier |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (let i = 0; i < cases.length; i++) {
    const row = evaluations[0].rows[i];
    lines.push(
      `| ${cell(row.id)} | ${row.interpretation} | ${row.score.toFixed(4)} | ${evaluations.map((evaluation) => evaluation.rows[i].tier ?? 'NONE').join(' | ')} |`,
    );
  }
  lines.push(
    '',
    '## Conclusion and next verification',
    '',
    'The controlled all-tier demo policy is an explicit integration demonstration candidate, not a production recommendation. Inspect CLEAR selections as false-positive actions, ABUSIVE cases with no tier as missed abuse, and threats/ambiguous/out-of-scope cases separately. A lower score for spam or scams does not mean the message is safe.',
    '',
    'Run final livestream verification separately with a controlled viewer: greeting, measured Delete/Timeout/Ban examples, repeated timeout, unban, saved report, and captured thresholds after restarting monitoring. Native inference and planning success alone do not establish provider execution or independently validated model quality.',
    '',
  );
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2])
      throw new Error('Usage: node scripts/ai-policy-evaluation.mjs results.json [cases.json]');
    const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const cases = JSON.parse(
      await readFile(
        process.argv[3] ?? new URL('./ai-prototype-cases.json', import.meta.url),
        'utf8',
      ),
    );
    console.log(renderPolicyReport(report, cases));
  } catch (error) {
    console.error('AI policy evaluation failed:', error.message);
    process.exitCode = 1;
  }
}
