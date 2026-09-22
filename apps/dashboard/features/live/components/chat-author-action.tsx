import type { ChatAuthorAction as AuthorAction } from '@moderator/contracts';

const statusLabels: Record<AuthorAction['status'], string> = {
  PENDING: 'pending',
  DISPATCHED: 'awaiting result',
  SUCCEEDED: 'confirmed',
  REJECTED: 'rejected',
  NOT_SENT: 'not sent',
  UNKNOWN: 'outcome unknown',
};

function describeAction(action: AuthorAction): string {
  switch (action.status) {
    case 'PENDING':
      return 'An execution record exists. No attempt has started yet.';
    case 'DISPATCHED':
      return 'An attempt has started. YouTube has not confirmed the result.';
    case 'SUCCEEDED':
      return action.action === 'TIMEOUT'
        ? `YouTube confirmed a timeout of ${action.duration_seconds} seconds. This does not indicate whether the timeout is still active.`
        : 'YouTube confirmed a permanent ban from this live chat. This records the execution result, not the current ban state.';
    case 'REJECTED':
      return 'YouTube rejected the request.';
    case 'NOT_SENT':
      return 'The request was not sent to YouTube.';
    case 'UNKNOWN':
      return 'The action may or may not have taken effect. No automatic retry will be made.';
  }
}

export function ChatAuthorAction({ action }: { action?: AuthorAction | null }) {
  if (!action) return null;

  const actionLabel = action.action === 'TIMEOUT' ? 'Timeout' : 'Ban';

  return (
    <div role="group" aria-label="Author action result" className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Automatic author action</span>
        <span className="rounded-md bg-muted px-2 py-1 font-medium">
          {actionLabel} {statusLabels[action.status]}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">{describeAction(action)}</p>

      <p className="text-xs text-muted-foreground">
        This result applies to the author in this livestream session. It may appear on multiple
        messages from the same author.
      </p>
    </div>
  );
}
