import type { ChatObservation } from '@moderator/contracts';

const ruleLabels = {
  ALLOW: 'Allowed',
  REVIEW: 'Flagged',
  ACTION_REQUIRED: 'Action required',
  ERROR: 'Check failed',
};
const actionLabels = {
  PENDING: 'pending',
  DISPATCHED: 'awaiting result',
  SUCCEEDED: 'confirmed',
  REJECTED: 'rejected',
  NOT_SENT: 'not sent',
  UNKNOWN: 'outcome unknown',
  BLOCKED: 'blocked',
  SUPPRESSED: 'not sent',
};
const planningLabels = {
  NOT_SELECTED: 'no action selected',
  BUILT_IN_PRIORITY: 'another rule takes priority',
  AWAITING_PLANS: 'preparing actions',
  PLANS_CREATED: 'actions planned',
  RUN_INACTIVE: 'monitoring ended',
};

export function ChatMessageSummary({ message }: { message: ChatObservation }) {
  const evaluation = message.evaluation;
  const ai = message.ai_shadow;
  const decision = message.ai_decision;
  const deletion = message.deletion;
  const author = message.author_action;
  const attention = evaluation && evaluation.outcome !== 'ALLOW';
  const uncertain = deletion?.status === 'UNKNOWN' || author?.status === 'UNKNOWN';
  return (
    <div className="space-y-2">
      <div role="group" aria-label="Moderation summary" className="flex flex-wrap gap-1.5 text-xs">
        {evaluation && (
          <span
            className={
              attention
                ? 'rounded-md bg-amber-50 px-2 py-1 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
                : 'rounded-md bg-muted px-2 py-1 text-muted-foreground'
            }
          >
            Rule check: {ruleLabels[evaluation.outcome]}
          </span>
        )}
        {message.blacklist && (
          <span className="rounded-md bg-muted px-2 py-1">Blocked word matched</span>
        )}
        {ai && (
          <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
            {ai.status === 'SUCCEEDED' ? 'AI checked' : 'AI check unavailable'}
          </span>
        )}
        {decision && (
          <span className="rounded-md bg-muted px-2 py-1">
            AI: {planningLabels[decision.planning_status]}
            {decision.selected_tier
              ? ` · ${decision.selected_tier === 'DELETE' ? 'Delete' : decision.selected_tier === 'TIMEOUT' ? 'Timeout' : 'Ban'}`
              : ''}
          </span>
        )}
        {deletion && (
          <span className="rounded-md border px-2 py-1">
            {deletion.status === 'SUCCEEDED'
              ? 'Message deleted'
              : `Deletion ${actionLabels[deletion.status]}`}
          </span>
        )}
        {author && (
          <span className="rounded-md border px-2 py-1">
            {author.action === 'TIMEOUT' ? 'Timeout' : 'Ban'} request {actionLabels[author.status]}
          </span>
        )}
      </div>
      {uncertain && (
        <p className="text-xs text-amber-800 dark:text-amber-200">
          YouTube’s result is uncertain. This request won’t be retried automatically.
        </p>
      )}
    </div>
  );
}
