import { chatAiDecision, storedAiActionDecision } from '@moderator/contracts';

export function summarizeChatAiDecision(
  input: unknown,
  scope: {
    channelId: string;
    sessionId: string;
    observationId: string;
    runId: string;
    externalMessageId: string;
    authorChannelId: string | null;
  },
  state: { builtInPriority: boolean; plansCreated: boolean; runActive: boolean },
) {
  if (input === null || input === undefined) return null;
  const record = storedAiActionDecision.parse(input);
  const decision = record.decision;
  const context = decision.context;
  if (
    context.channel_id !== scope.channelId ||
    context.session_id !== scope.sessionId ||
    context.observation_id !== scope.observationId ||
    context.run_id !== scope.runId ||
    context.external_message_id !== scope.externalMessageId ||
    context.author_channel_id !== scope.authorChannelId
  )
    throw new Error('Chat AI decision provenance scope mismatch.');
  if (Object.values(state).some((value) => typeof value !== 'boolean'))
    throw new Error('Invalid AI planning state.');
  const selected = decision.reason_code === 'THRESHOLD_MET';
  const output = decision.model_output;
  return chatAiDecision.parse({
    planner_version: decision.planner_version,
    policy_source: decision.snapshot.source,
    settings_revision: decision.snapshot.settings_revision,
    policy_model: decision.snapshot.configuration?.model ?? null,
    result_model:
      output === null
        ? null
        : {
            model_id: output.model_id,
            model_revision: output.model_revision,
            model_variant: output.model_variant,
            adapter_version: output.adapter_version,
          },
    severity_score: output?.severity_score ?? null,
    reason_code: decision.reason_code,
    selected_tier: decision.selected_tier,
    selected_threshold: decision.selected_threshold,
    author_action_status: decision.author_action_status,
    timeout_duration_seconds:
      decision.selected_tier === 'TIMEOUT'
        ? decision.snapshot.configuration!.timeout.duration_seconds
        : null,
    planning_status: !selected
      ? 'NOT_SELECTED'
      : state.builtInPriority
        ? 'BUILT_IN_PRIORITY'
        : state.plansCreated
          ? 'PLANS_CREATED'
          : !state.runActive
            ? 'RUN_INACTIVE'
            : 'AWAITING_PLANS',
    decided_at: record.created_at,
  });
}
