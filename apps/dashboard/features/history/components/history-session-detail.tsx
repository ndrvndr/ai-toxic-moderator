'use client';

import { Button } from '@/components/ui/button';
import { SavedSessionViewer } from '@/features/live/components/saved-session-viewer';
import { ApiError, getErrorMessage } from '@/lib/api-client';

import { useHistorySession } from '../hooks/use-history-session';
import { HistoryActionStatisticsPanel } from './history-action-statistics-panel';
import { HistoryStatisticsPanel } from './history-statistics-panel';

type HistorySessionDetailProps = {
  accountId: string;
  sessionId: string;
};

export function HistorySessionDetail({ accountId, sessionId }: HistorySessionDetailProps) {
  const session = useHistorySession(accountId, sessionId);

  if (session.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading saved session…
      </p>
    );
  }

  if (session.isError) {
    const unavailable =
      session.error instanceof ApiError && [403, 404, 422].includes(session.error.status);

    return (
      <div className="space-y-3 rounded-lg border p-5">
        <h1 className="text-xl font-semibold">
          {unavailable ? 'Session unavailable' : 'Unable to load session'}
        </h1>

        <p role="alert" className="text-sm text-muted-foreground">
          {unavailable
            ? 'This session does not exist or is not accessible to your account.'
            : getErrorMessage(session.error)}
        </p>

        {!unavailable && (
          <Button
            variant="outline"
            disabled={session.isFetching}
            onClick={() => void session.refetch()}
          >
            Try again
          </Button>
        )}
      </div>
    );
  }

  const saved = session.data;

  return (
    <div className="space-y-6">
      <header className="space-y-3 rounded-2xl border bg-muted/20 p-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Stream report
        </p>
        <h1 className="wrap-break-word text-3xl font-semibold tracking-tight">
          {saved.title || 'Untitled livestream'}
        </h1>

        <p className="text-sm text-muted-foreground">
          Saved{' '}
          <time dateTime={saved.created_at}>
            {new Date(saved.created_at).toLocaleString('en-US', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </time>
        </p>

        <p className="text-sm text-muted-foreground">
          Review the chat and moderation results saved for this stream. Viewing this report does not
          start monitoring.
        </p>
      </header>

      <HistoryStatisticsPanel
        key={`${accountId}:${saved.session_id}`}
        accountId={accountId}
        sessionId={saved.session_id}
      />

      <HistoryActionStatisticsPanel accountId={accountId} sessionId={saved.session_id} />

      <section aria-label="Saved session chat" className="rounded-2xl border p-5 sm:p-6">
        <SavedSessionViewer
          key={`${accountId}:${saved.session_id}`}
          accountId={accountId}
          session={saved}
        />
      </section>
    </div>
  );
}
