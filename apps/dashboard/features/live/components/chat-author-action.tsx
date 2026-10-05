import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { ChatAuthorAction as AuthorAction } from '@moderator/contracts';

const statusLabels: Record<AuthorAction['status'], string> = {
  PENDING: 'pending',
  DISPATCHED: 'awaiting result',
  SUCCEEDED: 'confirmed',
  REJECTED: 'rejected',
  NOT_SENT: 'not sent',
  UNKNOWN: 'outcome unknown',
  BLOCKED: 'blocked',
  SUPPRESSED: 'suppressed',
};

const blockDescriptions: Record<NonNullable<AuthorAction['block_reason']>, string> = {
  PREVIOUS_OUTCOME_UNKNOWN:
    'A previous action has an uncertain outcome. Further actions for this author are blocked pending reconciliation.',
  AUTHOR_ALREADY_BANNED:
    'A permanent ban was previously confirmed for this author in this session. Another action will not be sent.',
  MESSAGE_BEFORE_TIMEOUT_END:
    'This message was published before the previous timeout scheduling window ended. It will not trigger a delayed action.',
  MESSAGE_BEFORE_UNBAN:
    'This message was published or received before the recorded unban. It will not trigger a delayed timeout or ban.',
  AUTHOR_ACTION_IN_PROGRESS:
    'Another action for this author is awaiting a result. This execution has not been sent.',
  TIMEOUT_WINDOW_ACTIVE:
    'The previous timeout scheduling window has not ended. This execution has not been sent.',
};

function describeAction(action: AuthorAction): string {
  switch (action.status) {
    case 'PENDING':
      return 'An execution record exists, but no attempt has started. Dispatch still depends on worker configuration and current authorization.';
    case 'DISPATCHED':
      return 'An attempt has started. YouTube has not confirmed the result.';
    case 'SUCCEEDED':
      return action.action === 'TIMEOUT'
        ? `YouTube confirmed the timeout request. Requested duration: ${action.duration_seconds} seconds. This does not indicate whether the timeout is still active.`
        : 'YouTube confirmed a permanent ban from this live chat. This records the execution result, not the current ban state.';
    case 'REJECTED':
      return 'YouTube rejected the request.';
    case 'NOT_SENT':
      return 'The request was not sent to YouTube.';
    case 'UNKNOWN':
      if (action.evidence?.matching_event_observed) {
        return 'The action may or may not have taken effect. A matching YouTube moderation event was observed, but it does not prove that this application request caused the event. The request outcome remains unknown. No automatic retry will be made.';
      }

      if (action.evidence !== undefined) {
        return 'The action may or may not have taken effect. No matching event evidence has been stored. No automatic retry will be made.';
      }

      return 'The action may or may not have taken effect. No automatic retry will be made.';
    case 'BLOCKED':
    case 'SUPPRESSED':
      return action.block_reason
        ? blockDescriptions[action.block_reason]
        : 'This execution has not been sent.';
  }
}

export function ChatAuthorAction({ action }: { action?: AuthorAction | null }) {
  if (!action) return null;

  const actionLabel = action.action === 'TIMEOUT' ? 'Timeout' : 'Ban';

  return (
    <Card
      role="group"
      aria-label="Author action result"
      className="block ring-0 space-y-2 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Automatic author action</span>
        <Badge variant="secondary" className="rounded-md bg-muted px-2 py-1 font-medium">
          {actionLabel} {statusLabels[action.status]}
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground">{describeAction(action)}</p>

      {action.status === 'UNKNOWN' && action.evidence?.matching_event_observed && (
        <p className="text-xs font-medium">Matching moderation event observed</p>
      )}

      <p className="text-xs text-muted-foreground">
        This execution belongs to this message and targets its author. Execution status does not
        describe the author's current restriction on YouTube.
      </p>
    </Card>
  );
}
