'use client';

import { Button } from '@/components/ui/button';
import { useSavedSessions } from '@/features/live/hooks/use-saved-sessions';
import { getErrorMessage } from '@/lib/api-client';

import { HistorySessionCard } from './history-session-card';

type HistorySessionListProps = {
  accountId: string;
  search?: string;
};

export function HistorySessionList({ accountId, search = '' }: HistorySessionListProps) {
  const sessions = useSavedSessions(accountId, search);

  const items = [
    ...new Map(
      (sessions.data?.pages.flatMap((page) => page.items) ?? []).map(
        (session) => [session.session_id, session] as const,
      ),
    ).values(),
  ];

  if (sessions.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading livestream history…
      </p>
    );
  }

  if (sessions.isError) {
    return (
      <div className="space-y-3 rounded-lg border p-5">
        <p role="alert" className="text-sm text-destructive">
          {getErrorMessage(sessions.error)}
        </p>

        <Button
          variant="outline"
          disabled={sessions.isFetching}
          onClick={() => {
            if (sessions.isFetchNextPageError) {
              void sessions.fetchNextPage();
            } else {
              void sessions.refetch();
            }
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Opening a saved session does not start monitoring.
        </p>

        <Button
          variant="outline"
          disabled={sessions.isFetching}
          onClick={() => void sessions.refetch()}
        >
          {sessions.isRefetching ? 'Refreshing…' : 'Refresh history'}
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="space-y-2 rounded-lg border border-dashed p-6">
          <h2 className="font-medium">No saved sessions yet</h2>
          <p className="text-sm text-muted-foreground">
            Sessions will appear here after you start monitoring a livestream.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((session) => (
            <li key={session.session_id}>
              <HistorySessionCard session={session} />
            </li>
          ))}
        </ul>
      )}

      {sessions.hasNextPage && (
        <Button
          variant="outline"
          className="w-full"
          disabled={sessions.isFetching}
          onClick={() => void sessions.fetchNextPage()}
        >
          {sessions.isFetchingNextPage ? 'Loading…' : 'Load older sessions'}
        </Button>
      )}
    </div>
  );
}
