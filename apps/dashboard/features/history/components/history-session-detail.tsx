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
      <header className="space-y-2">
        <h1 className="wrap-break-word text-2xl font-semibold">
          {saved.title || 'Untitled livestream'}
        </h1>

        <p className="text-sm text-muted-foreground">
          Saved{' '}
          <time dateTime={saved.created_at}>{new Date(saved.created_at).toLocaleString()}</time>
        </p>

        <p className="text-sm text-muted-foreground">
          Review stored chat and moderation results. Opening this page does not start monitoring.
        </p>
      </header>

      <HistoryStatisticsPanel
        key={`${accountId}:${saved.session_id}`}
        accountId={accountId}
        sessionId={saved.session_id}
      />

      <HistoryActionStatisticsPanel accountId={accountId} sessionId={saved.session_id} />

      <section aria-label="Saved session chat" className="rounded-lg border p-5">
        <SavedSessionViewer
          key={`${accountId}:${saved.session_id}`}
          accountId={accountId}
          session={saved}
        />
      </section>
    </div>
  );
}
