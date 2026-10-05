import { Card } from '@/components/ui/card';
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
      <Card
        role="group"
        aria-label="Moderation summary"
        className="rounded-none bg-transparent p-0 ring-0 flex-row flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      >
        {evaluation?.classifier_version === 'blacklist-only-1' && !message.blacklist ? (
          <span>No blocked word matched</span>
        ) : evaluation && evaluation.classifier_version !== 'blacklist-only-1' ? (
          <span
            className={
              attention ? 'font-medium text-amber-800 dark:text-amber-200' : 'text-muted-foreground'
            }
          >
            Rule check: {ruleLabels[evaluation.outcome]}
          </span>
        ) : null}
        {message.blacklist && <span className="font-medium">Blocked word matched</span>}
        {ai && (
          <span className="text-muted-foreground">
            {ai.status === 'SUCCEEDED' ? 'AI checked' : 'AI check unavailable'}
          </span>
        )}
        {decision && (
          <span className="font-medium">
            AI: {planningLabels[decision.planning_status]}
            {decision.selected_tier
              ? ` · ${decision.selected_tier === 'DELETE' ? 'Delete' : decision.selected_tier === 'TIMEOUT' ? 'Timeout' : 'Ban'}`
              : ''}
          </span>
        )}
        {deletion && (
          <span className="font-medium text-foreground">
            {deletion.status === 'SUCCEEDED'
              ? 'Message deleted'
              : `Deletion ${actionLabels[deletion.status]}`}
          </span>
        )}
        {author && (
          <span className="font-medium text-foreground">
            {author.action === 'TIMEOUT' ? 'Timeout' : 'Ban'} request {actionLabels[author.status]}
          </span>
        )}
      </Card>
      {uncertain && (
        <p className="text-xs text-amber-800 dark:text-amber-200">
          YouTube’s result is uncertain. This request won’t be retried automatically.
        </p>
      )}
    </div>
  );
}
