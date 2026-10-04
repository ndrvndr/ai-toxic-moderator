import { z } from 'zod';
import { aiActionDecision } from './ai-action-decision';
import { aiModerationModelIdentity } from './ai-moderation-settings';

/** Public policy evidence only; planning state never confirms a provider outcome. */
export const chatAiDecision = z
  .strictObject({
    planner_version: aiActionDecision.shape.planner_version,
    policy_source: z.enum(['SAVED', 'DEFAULT', 'LEGACY']),
    settings_revision: z.number().int().positive().safe().nullable(),
    policy_model: aiModerationModelIdentity.nullable(),
    result_model: aiModerationModelIdentity.nullable(),
    severity_score: z.number().min(0).max(1).nullable(),
    reason_code: aiActionDecision.shape.reason_code,
    selected_tier: aiActionDecision.shape.selected_tier,
    selected_threshold: aiActionDecision.shape.selected_threshold,
    author_action_status: aiActionDecision.shape.author_action_status,
    timeout_duration_seconds: z.number().int().min(1).max(86400).nullable(),
    planning_status: z.enum([
      'NOT_SELECTED',
      'BUILT_IN_PRIORITY',
      'AWAITING_PLANS',
      'PLANS_CREATED',
      'RUN_INACTIVE',
    ]),
    decided_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    const invalid = (message: string) => context.addIssue({ code: 'custom', message });
    const saved = value.policy_source === 'SAVED';
    if (saved !== (value.settings_revision !== null) || saved !== (value.policy_model !== null))
      invalid('Saved policy provenance requires its revision and model.');
    const selected = value.reason_code === 'THRESHOLD_MET';
    if (
      selected !== (value.selected_tier !== null) ||
      selected !== (value.selected_threshold !== null)
    )
      invalid('Threshold selection must match the decision reason.');
    if (selected === (value.planning_status === 'NOT_SELECTED'))
      invalid('Planning state must distinguish selected decisions from skipped evaluation.');
    if ((value.selected_tier === 'TIMEOUT') !== (value.timeout_duration_seconds !== null))
      invalid('Requested timeout duration is only present for a timeout tier.');
    const authorSelected = value.selected_tier === 'TIMEOUT' || value.selected_tier === 'BAN';
    if (authorSelected === (value.author_action_status === 'NOT_SELECTED'))
      invalid('Author planning must match the selected tier.');
    const sameModel =
      value.policy_model !== null &&
      value.result_model !== null &&
      (['model_id', 'model_revision', 'model_variant', 'adapter_version'] as const).every(
        (key) => value.policy_model![key] === value.result_model![key],
      );
    if (
      selected &&
      (!saved ||
        !sameModel ||
        value.severity_score === null ||
        value.severity_score < value.selected_threshold!)
    )
      invalid('A selected tier requires matching model output meeting its captured threshold.');
    if (value.severity_score !== null && value.result_model === null)
      invalid('A score requires considered model provenance.');
    if (
      [
        'BLACKLIST_MATCH',
        'NO_SAVED_POLICY',
        'AI_DISABLED',
        'OUTPUT_MISSING',
        'OUTPUT_INVALID',
      ].includes(value.reason_code) &&
      (value.result_model !== null || value.severity_score !== null)
    )
      invalid('Skipped or missing output cannot claim considered model evidence.');
  });

export type ChatAiDecision = z.infer<typeof chatAiDecision>;
