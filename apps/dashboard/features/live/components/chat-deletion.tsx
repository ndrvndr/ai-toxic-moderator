import type { ChatDeletion as Deletion } from '@moderator/contracts';

const statusDetails: Record<Deletion['status'], { label: string; description: string }> = {
  PENDING: {
    label: 'Deletion pending',
    description: 'A deletion is planned. It has not been attempted yet.',
  },
  DISPATCHED: {
    label: 'Deletion awaiting result',
    description: 'An attempt has started. YouTube has not confirmed the result.',
  },
  SUCCEEDED: {
    label: 'Deleted',
    description: 'YouTube confirmed that the message was deleted.',
  },
  REJECTED: {
    label: 'Deletion rejected',
    description: 'YouTube rejected the deletion request.',
  },
  NOT_SENT: {
    label: 'Deletion not sent',
    description: 'The deletion request was not sent to YouTube.',
  },
  UNKNOWN: {
    label: 'Deletion outcome unknown',
    description: 'The message may or may not have been deleted. No automatic retry will be made.',
  },
};

export function ChatDeletion({ deletion }: { deletion?: Deletion | null }) {
  if (!deletion) return null;
  const details = statusDetails[deletion.status];

  return (
    <div role="group" aria-label="Deletion result" className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Automatic action</span>
        <span className="rounded-md bg-muted px-2 py-1 font-medium">{details.label}</span>
      </div>
      <p className="text-xs text-muted-foreground">{details.description}</p>
    </div>
  );
}
