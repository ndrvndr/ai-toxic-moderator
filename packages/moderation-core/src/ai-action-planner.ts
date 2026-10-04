import {
  aiModerationSettingsSnapshot,
  aiShadowIdentity,
  aiShadowResult,
  blacklistActionBundle,
  blacklistActionPlanInput,
  moderationActionPlan,
  type AiModerationSettingsSnapshot,
  type AiShadowResult,
  type ModerationActionPlan,
} from '@moderator/contracts';

export const AI_ACTION_PLANNER_VERSION = 'ai-threshold-1';

export const aiActionPlanInput = blacklistActionPlanInput.extend({
  observation_id: aiShadowIdentity.shape.observation_id.transform((value) => value.toLowerCase()),
});
export type AiActionPlanInput = ReturnType<typeof aiActionPlanInput.parse>;
export type AiActionReasonCode =
  | 'BLACKLIST_MATCH'
  | 'NO_SAVED_POLICY'
  | 'AI_DISABLED'
  | 'OUTPUT_MISSING'
  | 'OUTPUT_INVALID'
  | 'MODEL_MISMATCH'
  | 'INFERENCE_ERROR'
  | 'INPUT_TRUNCATED'
  | 'NO_THRESHOLD_MET'
  | 'THRESHOLD_MET';

/** An in-memory planning result, never an execution outcome or dispatch authorization. */
export interface AiActionDecision {
  planner_version: typeof AI_ACTION_PLANNER_VERSION;
  policy_version: string;
  context: AiActionPlanInput;
  snapshot: AiModerationSettingsSnapshot;
  model_output: AiShadowResult | null;
  reason_code: AiActionReasonCode;
  selected_tier: 'DELETE' | 'TIMEOUT' | 'BAN' | null;
  selected_threshold: number | null;
  author_action_status: 'NOT_SELECTED' | 'PLANNED' | 'TARGET_UNAVAILABLE';
  plans: ModerationActionPlan[];
}

export class AiActionPlanner {
  private readonly snapshot: AiModerationSettingsSnapshot;

  constructor(snapshot: unknown) {
    this.snapshot = aiModerationSettingsSnapshot.parse(snapshot);
  }

  /** Requires a validated blacklist decision for the same message before considering AI. */
  plan(input: unknown, output: unknown, blacklist: unknown): AiActionDecision {
    const context = aiActionPlanInput.parse(input);
    if (
      context.run_id !== this.snapshot.run_id.toLowerCase() ||
      context.channel_id !== this.snapshot.channel_id.toLowerCase()
    ) {
      throw new Error('AI policy does not belong to this run and channel.');
    }
    const prior = blacklistActionBundle.parse(blacklist);
    for (const key of ['run_id', 'channel_id', 'session_id', 'classification_id'] as const) {
      if (prior[key] !== context[key])
        throw new Error('Blacklist decision does not belong to this message scope.');
    }
    for (const plan of prior.plans) {
      if (
        (plan.action === 'DELETE' && plan.external_message_id !== context.external_message_id) ||
        ((plan.action === 'TIMEOUT' || plan.action === 'BAN') &&
          plan.author_channel_id !== context.author_channel_id)
      )
        throw new Error('Blacklist decision targets a different message or author.');
    }

    const decision: AiActionDecision = {
      planner_version: AI_ACTION_PLANNER_VERSION,
      policy_version: `${AI_ACTION_PLANNER_VERSION}-${context.run_id}`,
      context,
      // Return a separate parsed copy so callers cannot mutate the planner's captured policy.
      snapshot: aiModerationSettingsSnapshot.parse(this.snapshot),
      model_output: null,
      reason_code: 'NO_THRESHOLD_MET',
      selected_tier: null,
      selected_threshold: null,
      author_action_status: 'NOT_SELECTED',
      plans: [],
    };
    const skip = (reason: AiActionReasonCode) => {
      decision.reason_code = reason;
      return decision;
    };
    if (prior.selected_rule_id !== null) return skip('BLACKLIST_MATCH');
    if (this.snapshot.source !== 'SAVED') return skip('NO_SAVED_POLICY');
    const configuration = this.snapshot.configuration;
    if (!configuration.automatic_actions_enabled) return skip('AI_DISABLED');
    if (output === null || output === undefined) return skip('OUTPUT_MISSING');
    const parsed = aiShadowResult.safeParse(output);
    if (!parsed.success) return skip('OUTPUT_INVALID');
    const result = parsed.data;
    for (const key of ['run_id', 'channel_id', 'session_id', 'observation_id'] as const) {
      if (result[key].toLowerCase() !== context[key])
        throw new Error('AI output does not belong to this message scope.');
    }
    decision.model_output = result;
    for (const key of ['model_id', 'model_revision', 'model_variant', 'adapter_version'] as const) {
      if (result[key] !== configuration.model[key]) return skip('MODEL_MISMATCH');
    }
    if (result.status === 'ERROR') return skip('INFERENCE_ERROR');
    if (result.truncated) return skip('INPUT_TRUNCATED');

    const tier = (['ban', 'timeout', 'delete'] as const).find(
      (name) =>
        configuration[name].enabled && result.severity_score >= configuration[name].threshold,
    );
    if (!tier) return skip('NO_THRESHOLD_MET');
    decision.reason_code = 'THRESHOLD_MET';
    decision.selected_tier = tier === 'ban' ? 'BAN' : tier === 'timeout' ? 'TIMEOUT' : 'DELETE';
    decision.selected_threshold = configuration[tier].threshold;
    const scope = {
      classification_id: context.classification_id,
      channel_id: context.channel_id,
      session_id: context.session_id,
    };
    const reason = `Model expected severity met the captured ${tier} threshold.`;
    decision.plans.push(
      moderationActionPlan.parse({
        ...scope,
        policy_version: `${decision.policy_version}:message`,
        reason,
        action: 'DELETE',
        external_message_id: context.external_message_id,
      }),
    );
    if (tier !== 'delete') {
      if (!context.author_channel_id || !/^UC[A-Za-z0-9_-]{22}$/.test(context.author_channel_id)) {
        decision.author_action_status = 'TARGET_UNAVAILABLE';
      } else {
        decision.author_action_status = 'PLANNED';
        decision.plans.push(
          moderationActionPlan.parse({
            ...scope,
            policy_version: `${decision.policy_version}:author`,
            reason,
            author_channel_id: context.author_channel_id,
            ...(tier === 'timeout'
              ? { action: 'TIMEOUT', duration_seconds: configuration.timeout.duration_seconds }
              : { action: 'BAN' }),
          }),
        );
      }
    }
    return decision;
  }
}
