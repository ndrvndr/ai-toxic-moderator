import type { ChatAiDecision as Decision } from '@moderator/contracts';

const reasons: Record<Decision['reason_code'], string> = {
  BLACKLIST_MATCH: 'The captured blacklist matched this message and takes priority over AI.',
  NO_SAVED_POLICY: 'This run has no saved AI moderation policy.',
  AI_DISABLED: 'Automatic AI actions were disabled in the captured settings.',
  OUTPUT_MISSING:
    'No model output was available when this decision was saved. This decision will not be replanned automatically.',
  OUTPUT_INVALID: 'The model output was invalid. No AI action was selected.',
  MODEL_MISMATCH: 'The considered output does not match the model configured for this run.',
  INFERENCE_ERROR: 'Model inference failed. No AI action was selected.',
  INPUT_TRUNCATED: 'The model only processed part of the message. No AI action was selected.',
  NO_THRESHOLD_MET: 'The considered severity score did not meet an enabled action threshold.',
  THRESHOLD_MET: 'The highest enabled threshold met by the considered severity score was selected.',
};

const planning: Record<Decision['planning_status'], { label: string; description: string }> = {
  NOT_SELECTED: {
    label: 'No AI action selected',
    description: 'Blocked word decisions are evaluated separately.',
  },
  BUILT_IN_PRIORITY: {
    label: 'AI action suppressed',
    description: 'A blocked word action or a previously recorded moderation plan takes priority.',
  },
  AWAITING_PLANS: {
    label: 'AI plans pending',
    description: 'The decision is stored, but its action plans have not all been created.',
  },
  PLANS_CREATED: {
    label: 'AI plans ready',
    description:
      'The action plans are stored. Dispatch still depends on worker configuration, access, and run state. Provider outcomes appear separately.',
  },
  RUN_INACTIVE: {
    label: 'Run inactive',
    description:
      'The original monitoring run is inactive. Missing AI action plans are not created for this run.',
  },
};

const tiers = { DELETE: 'Delete', TIMEOUT: 'Timeout', BAN: 'Ban' } as const;

export function ChatAiDecision({ decision }: { decision: Decision | null | undefined }) {
  if (!decision) return null;
  const state = planning[decision.planning_status];
  return (
    <div
      role="group"
      aria-label="AI moderation decision"
      className="space-y-2 rounded-lg border p-3 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">AI moderation decision</span>
        <span className="rounded-md bg-muted px-2 py-1 font-medium">{state.label}</span>
      </div>
      <p>{reasons[decision.reason_code]}</p>
      {decision.selected_tier && (
        <p>
          Selected tier: {tiers[decision.selected_tier]}. Captured threshold:{' '}
          {decision.selected_threshold!.toFixed(4)} / 1.
          {decision.timeout_duration_seconds !== null &&
            ` Requested timeout: ${decision.timeout_duration_seconds} seconds.`}
        </p>
      )}
      {decision.severity_score !== null && (
        <p>
          Considered severity: {decision.severity_score.toFixed(4)} / 1. This is not a probability
          of a policy violation.
        </p>
      )}
      {decision.author_action_status === 'TARGET_UNAVAILABLE' && (
        <p>The author could not be identified. Only message deletion was planned.</p>
      )}
      <p className="text-muted-foreground">{state.description}</p>
      <details className="text-muted-foreground">
        <summary className="cursor-pointer">AI decision details</summary>
        <dl className="mt-2 space-y-2 wrap-break-word">
          <div>
            <dt className="font-medium">Captured settings</dt>
            <dd>
              {decision.policy_source === 'SAVED'
                ? `Revision ${decision.settings_revision}`
                : decision.policy_source}
            </dd>
          </div>
          <div>
            <dt className="font-medium">Planner</dt>
            <dd>{decision.planner_version}</dd>
          </div>
          <div>
            <dt className="font-medium">Decision reason</dt>
            <dd>{decision.reason_code}</dd>
          </div>
          {decision.policy_model && (
            <div>
              <dt className="font-medium">Captured model</dt>
              <dd>{decision.policy_model.model_id}</dd>
              <dd>{decision.policy_model.model_revision}</dd>
            </div>
          )}
          {decision.result_model && (
            <div>
              <dt className="font-medium">Considered model</dt>
              <dd>{decision.result_model.model_id}</dd>
              <dd>{decision.result_model.model_revision}</dd>
              <dd>
                {decision.result_model.model_variant} · {decision.result_model.adapter_version}
              </dd>
            </div>
          )}
          <div>
            <dt className="font-medium">Decision saved</dt>
            <dd>{decision.decided_at}</dd>
          </div>
        </dl>
      </details>
      <p className="text-muted-foreground">
        This saved decision uses the settings captured for its run and the considered model result.
        The latest model output may differ. A selected tier does not confirm execution.
      </p>
    </div>
  );
}
