'use client';
import { Badge } from '@/components/ui/badge';

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import type { SavedSession } from '@moderator/contracts';

type HistorySessionCardProps = {
  session: SavedSession;
};

const statusLabels: Record<NonNullable<SavedSession['latest_status']>, string> = {
  STARTING: 'Monitoring starting',
  RUNNING: 'Monitoring started',
  STOPPING: 'Monitoring stopping',
  STOPPED: 'Monitoring ended',
  FAILED: 'Monitoring stopped unexpectedly',
};

export function HistorySessionCard({ session }: HistorySessionCardProps) {
  const status =
    session.latest_status === null ? 'Saved stream' : statusLabels[session.latest_status];

  return (
    <article className="flex flex-col gap-4 rounded-xl border bg-card p-5 transition-colors hover:bg-muted/20 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-2">
        <h2 className="wrap-break-word font-medium">{session.title || 'Untitled livestream'}</h2>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="rounded-md bg-muted px-2 py-1">
            {status}
          </Badge>
          <span>
            Saved{' '}
            <time dateTime={session.created_at}>
              {new Date(session.created_at).toLocaleString('en-US', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </time>
          </span>
        </div>
      </div>

      <Button asChild variant="outline">
        <Link href={`/history/${session.session_id}`}>View report</Link>
      </Button>
    </article>
  );
}
