import { z } from 'zod';
import { aiModerationSettingsSnapshot } from './ai-moderation-settings';
import { aiShadowIdentity, aiShadowResult } from './ai-shadow';
import { blacklistActionBundle, blacklistActionPlanInput } from './blacklist-action-plan';
import { moderationActionPlan } from './moderation-action';

const id = z.uuid().transform((value) => value.toLowerCase());
export const aiActionDecisionScope = z.strictObject({
  run_id: id,
  channel_id: id,
  session_id: id,
  observation_id: id,
  classification_id: id,
});
export const aiActionDecisionSave = aiActionDecisionScope.extend({
  model_result_id: id.nullable(),
});

export const aiActionDecision = z
  .strictObject({
    planner_version: z.literal('ai-threshold-1'),
    policy_version: z.string().min(1).max(110),
    context: blacklistActionPlanInput.extend({
      observation_id: aiShadowIdentity.shape.observation_id.transform((value) =>
        value.toLowerCase(),
      ),
    }),
    snapshot: aiModerationSettingsSnapshot,
    model_output: aiShadowResult.nullable(),
    reason_code: z.enum([
      'BLACKLIST_MATCH',
      'NO_SAVED_POLICY',
      'AI_DISABLED',
      'OUTPUT_MISSING',
      'OUTPUT_INVALID',
      'MODEL_MISMATCH',
      'INFERENCE_ERROR',
      'INPUT_TRUNCATED',
      'NO_THRESHOLD_MET',
      'THRESHOLD_MET',
    ]),
    selected_tier: z.enum(['DELETE', 'TIMEOUT', 'BAN']).nullable(),
    selected_threshold: z.number().min(0).max(1).nullable(),
    author_action_status: z.enum(['NOT_SELECTED', 'PLANNED', 'TARGET_UNAVAILABLE']),
    plans: z.array(moderationActionPlan).max(2),
  })
  .superRefine((decision, context) => {
    const invalid = (message: string) => context.addIssue({ code: 'custom', message });
    const scope = decision.context;
    if (decision.policy_version !== `${decision.planner_version}-${scope.run_id}`)
      invalid('Decision must use its deterministic run policy slot.');
    if (
      decision.snapshot.run_id.toLowerCase() !== scope.run_id ||
      decision.snapshot.channel_id.toLowerCase() !== scope.channel_id
    )
      invalid('Captured policy must belong to the decision scope.');
    const output = decision.model_output;
    if (
      ['BLACKLIST_MATCH', 'NO_SAVED_POLICY', 'AI_DISABLED'].includes(decision.reason_code) &&
      output !== null
    )
      invalid('Skipped AI evaluation cannot claim considered model output.');
    if (output)
      for (const key of ['run_id', 'channel_id', 'session_id', 'observation_id'] as const) {
        if (output[key].toLowerCase() !== scope[key])
          invalid('Model output must belong to the decision scope.');
      }
    const configuration = decision.snapshot.configuration;
    const matchingModel =
      configuration &&
      output &&
      (['model_id', 'model_revision', 'model_variant', 'adapter_version'] as const).every(
        (key) => configuration.model[key] === output[key],
      );
    let expectedReason: string;
    let tier: 'delete' | 'timeout' | 'ban' | undefined;
    if (decision.reason_code === 'BLACKLIST_MATCH') expectedReason = 'BLACKLIST_MATCH';
    else if (!configuration) expectedReason = 'NO_SAVED_POLICY';
    else if (!configuration.automatic_actions_enabled) expectedReason = 'AI_DISABLED';
    else if (!output)
      expectedReason =
        decision.reason_code === 'OUTPUT_INVALID' ? 'OUTPUT_INVALID' : 'OUTPUT_MISSING';
    else if (!matchingModel) expectedReason = 'MODEL_MISMATCH';
    else if (output.status === 'ERROR') expectedReason = 'INFERENCE_ERROR';
    else if (output.truncated) expectedReason = 'INPUT_TRUNCATED';
    else {
      tier = (['ban', 'timeout', 'delete'] as const).find(
        (name) =>
          configuration[name].enabled && output.severity_score >= configuration[name].threshold,
      );
      expectedReason = tier ? 'THRESHOLD_MET' : 'NO_THRESHOLD_MET';
    }
    if (decision.reason_code !== expectedReason)
      invalid('Decision reason must match the captured policy and model output.');
    if (!tier || !configuration) {
      if (
        decision.selected_tier !== null ||
        decision.selected_threshold !== null ||
        decision.plans.length ||
        decision.author_action_status !== 'NOT_SELECTED'
      )
        invalid('A skipped decision cannot contain selected thresholds or plans.');
      return;
    }
    const action = tier === 'delete' ? 'DELETE' : tier === 'timeout' ? 'TIMEOUT' : 'BAN';
    const authorAvailable =
      scope.author_channel_id !== null && /^UC[A-Za-z0-9_-]{22}$/.test(scope.author_channel_id);
    const authorStatus =
      tier === 'delete' ? 'NOT_SELECTED' : authorAvailable ? 'PLANNED' : 'TARGET_UNAVAILABLE';
    if (
      decision.selected_tier !== action ||
      decision.selected_threshold !== configuration[tier].threshold ||
      decision.author_action_status !== authorStatus
    )
      invalid('Selected tier must match the highest enabled threshold and available target.');
    if (decision.plans.length !== (authorStatus === 'PLANNED' ? 2 : 1))
      invalid('Independent action slots are incomplete.');
    const message = decision.plans[0];
    if (
      message?.action !== 'DELETE' ||
      message.external_message_id !== scope.external_message_id ||
      message.policy_version !== `${decision.policy_version}:message`
    )
      invalid('Message slot must delete the observed message.');
    const author = decision.plans[1];
    if (
      author &&
      (author.action !== action ||
        (author.action !== 'TIMEOUT' && author.action !== 'BAN') ||
        author.author_channel_id !== scope.author_channel_id ||
        author.policy_version !== `${decision.policy_version}:author`)
    )
      invalid('Author slot must target the observed author with the selected action.');
    if (
      author?.action === 'TIMEOUT' &&
      author.duration_seconds !== configuration.timeout.duration_seconds
    )
      invalid('Timeout duration must match the captured policy.');
    for (const plan of decision.plans) {
      if (plan.reason !== `Model expected severity met the captured ${tier} threshold.`)
        invalid('Plan reason must describe the selected captured threshold.');
      for (const key of ['classification_id', 'channel_id', 'session_id'] as const) {
        if (plan[key].toLowerCase() !== scope[key])
          invalid('Plan must belong to the decision scope.');
      }
    }
  });

export const storedAiActionDecision = z
  .strictObject({
    id,
    model_result_id: id.nullable(),
    decision: aiActionDecision,
    blacklist: blacklistActionBundle,
    created_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((record, context) => {
    const invalid = (message: string) => context.addIssue({ code: 'custom', message });
    for (const key of ['run_id', 'channel_id', 'session_id', 'classification_id'] as const) {
      if (record.blacklist[key] !== record.decision.context[key])
        invalid('Blacklist audit must belong to the decision scope.');
    }
    if (
      (record.blacklist.selected_rule_id !== null) !==
      (record.decision.reason_code === 'BLACKLIST_MATCH')
    )
      invalid('Blacklist matches must take priority over AI.');
    for (const plan of record.blacklist.plans) {
      if (
        (plan.action === 'DELETE' &&
          plan.external_message_id !== record.decision.context.external_message_id) ||
        ((plan.action === 'TIMEOUT' || plan.action === 'BAN') &&
          plan.author_channel_id !== record.decision.context.author_channel_id)
      )
        invalid('Blacklist plans must target the observed message and author.');
    }
    if (record.decision.model_output !== null && record.model_result_id === null)
      invalid('Considered model output requires a persisted result reference.');
  });

export type StoredAiActionDecision = z.infer<typeof storedAiActionDecision>;
