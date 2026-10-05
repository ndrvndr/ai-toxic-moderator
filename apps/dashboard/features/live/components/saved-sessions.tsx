'use client';
import { Alert } from '@/components/ui/alert';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/api-client';

import { useSavedSessions } from '../hooks/use-saved-sessions';
import { SavedSessionViewer } from './saved-session-viewer';

export function SavedSessions({ accountId }: { accountId: string }) {
  const sessions = useSavedSessions(accountId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = [
    ...new Map(
      (sessions.data?.pages.flatMap((page) => page.items) ?? []).map(
        (session) => [session.session_id, session] as const,
      ),
    ).values(),
  ];

  const selected = items.find((session) => session.session_id === selectedId);

  return (
    <section aria-labelledby="saved-sessions-title" className="space-y-4 border-t pt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="saved-sessions-title" className="text-lg font-semibold">
            Saved sessions
          </h2>
          <p className="text-sm text-muted-foreground">
            Open previously monitored streams and view their stored chat. Opening a session does not
            start monitoring.
          </p>
        </div>

        <Button
          variant="outline"
          disabled={sessions.isFetching}
          onClick={() => void sessions.refetch()}
        >
          Refresh sessions
        </Button>
      </div>

      {sessions.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading saved sessions…
        </p>
      )}

      {sessions.isError && (
        <Alert role="alert" className="text-sm text-destructive">
          {getErrorMessage(sessions.error)}
        </Alert>
      )}

      {sessions.isSuccess && items.length === 0 && (
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          No saved sessions are available for your account.
        </p>
      )}

      <ul className="space-y-2">
        {items.map((session) => (
          <li
            key={session.session_id}
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
          >
            <div className="min-w-0">
              <p className="wrap-break-word font-medium">{session.title}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(session.created_at).toLocaleString()} ·{' '}
                {session.latest_status ?? 'NO RUN'}
              </p>
            </div>

            <Button
              variant={selectedId === session.session_id ? 'secondary' : 'outline'}
              onClick={() =>
                setSelectedId((current) =>
                  current === session.session_id ? null : session.session_id,
                )
              }
            >
              {selectedId === session.session_id ? 'Close' : 'Open'}
            </Button>
          </li>
        ))}
      </ul>

      {sessions.hasNextPage && (
        <Button
          variant="outline"
          disabled={sessions.isFetching}
          onClick={() => void sessions.fetchNextPage()}
        >
          {sessions.isFetchingNextPage ? 'Loading…' : 'Load older sessions'}
        </Button>
      )}

      {selected && (
        <div className="space-y-4 rounded-lg border p-5">
          <h3 className="font-semibold">{selected.title}</h3>
          <SavedSessionViewer
            key={`${accountId}:${selected.session_id}`}
            accountId={accountId}
            session={selected}
          />
        </div>
      )}
    </section>
  );
}
