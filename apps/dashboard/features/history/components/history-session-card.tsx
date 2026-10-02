'use client';

import { Button } from '@/components/ui/button';
import type { SavedSession } from '@moderator/contracts';

type HistorySessionCardProps = {
  session: SavedSession;
  selected: boolean;
  onToggle: () => void;
};

const statusLabels: Record<NonNullable<SavedSession['latest_status']>, string> = {
  STARTING: 'Starting',
  RUNNING: 'Running',
  STOPPING: 'Stopping',
  STOPPED: 'Stopped',
  FAILED: 'Failed',
};

export function HistorySessionCard({ session, selected, onToggle }: HistorySessionCardProps) {
  const status =
    session.latest_status === null ? 'No monitoring run' : statusLabels[session.latest_status];

  return (
    <article className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-2">
        <h2 className="wrap-break-word font-medium">{session.title || 'Untitled livestream'}</h2>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-md bg-muted px-2 py-1">{status}</span>
          <span>
            Saved{' '}
            <time dateTime={session.created_at}>
              {new Date(session.created_at).toLocaleString()}
            </time>
          </span>
        </div>
      </div>

      <Button
        variant={selected ? 'secondary' : 'outline'}
        aria-expanded={selected}
        aria-controls={selected ? 'history-session-details' : undefined}
        onClick={onToggle}
      >
        {selected ? 'Close session' : 'Open session'}
      </Button>
    </article>
  );
}
