'use client';

import type { ActionExecutionCounts } from '@moderator/contracts';

import { Button } from '@/components/ui/button';
import { ApiError, getErrorMessage } from '@/lib/api-client';

import { useHistoryActionStatistics } from '../hooks/use-history-action-statistics';

const outcomes = [
  { key: 'total', label: 'Total' },
  { key: 'dispatched', label: 'Awaiting result' },
  { key: 'succeeded', label: 'Confirmed' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'not_sent', label: 'Not sent' },
  { key: 'unknown', label: 'Unknown' },
] as const satisfies ReadonlyArray<{
  key: keyof ActionExecutionCounts;
  label: string;
}>;

type HistoryActionStatisticsPanelProps = {
  accountId: string;
  sessionId: string;
};

export function HistoryActionStatisticsPanel({
  accountId,
  sessionId,
}: HistoryActionStatisticsPanelProps) {
  const statistics = useHistoryActionStatistics(accountId, sessionId);

  if (statistics.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading moderation action results…
      </p>
    );
  }

  if (statistics.isError) {
    const unavailable =
      statistics.error instanceof ApiError &&
      [401, 403, 404, 422].includes(statistics.error.status);

    return (
      <section aria-label="Moderation action results" className="space-y-3 rounded-lg border p-5">
        <h2 className="font-semibold">Moderation action results</h2>

        <p role="alert" className="text-sm text-destructive">
          {unavailable
            ? 'Action results are unavailable. Check your session and access permissions.'
            : getErrorMessage(statistics.error)}
        </p>

        {!unavailable && (
          <Button
            variant="outline"
            disabled={statistics.isFetching}
            onClick={() => void statistics.refetch()}
          >
            Try again
          </Button>
        )}
      </section>
    );
  }

  const data = statistics.data;
  const actions = [
    { label: 'Messages deleted', counts: data.delete },
    { label: 'Timeouts confirmed', counts: data.timeout },
    { label: 'Bans confirmed', counts: data.ban },
  ];

  const hasAttempts = actions.some(({ counts }) => counts.total > 0);
  const unknown = actions.reduce((total, { counts }) => total + counts.unknown, 0);
  const awaiting = actions.reduce((total, { counts }) => total + counts.dispatched, 0);

  return (
    <section
      aria-label="Moderation action results"
      className="space-y-5 rounded-2xl border bg-card p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">What moderation did</h2>

        <Button
          variant="outline"
          disabled={statistics.isFetching}
          onClick={() => void statistics.refetch()}
        >
          {statistics.isFetching ? 'Refreshing…' : 'Refresh action results'}
        </Button>
      </div>

      {!hasAttempts && (
        <p className="text-sm text-muted-foreground">
          No moderation attempts have been recorded for this session.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {actions.map(({ label, counts }) => (
          <article key={label} className="space-y-4 rounded-xl bg-muted/40 p-4">
            <dl>
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="mt-2 text-3xl font-semibold tabular-nums">
                {counts.succeeded.toLocaleString('en-US')}
              </dd>
            </dl>
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-xs font-medium">All outcomes</summary>
              <dl className="mt-3 space-y-2">
                {outcomes.map(({ key, label: outcomeLabel }) => (
                  <div key={key} className="flex justify-between gap-4 text-sm">
                    <dt className="text-muted-foreground">{outcomeLabel}</dt>
                    <dd className="font-medium tabular-nums">
                      {counts[key].toLocaleString('en-US')}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </article>
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        These actions were confirmed by YouTube. Timeouts and bans count requests, not unique
        viewers, and do not show whether a restriction is still active.
      </p>
      {unknown > 0 && (
        <p
          role="status"
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {unknown.toLocaleString('en-US')} {unknown === 1 ? 'request has' : 'requests have'} an
          uncertain result. These requests are not counted as confirmed and will not be retried
          automatically.
        </p>
      )}
      {awaiting > 0 && (
        <p className="text-sm text-muted-foreground">
          {awaiting.toLocaleString('en-US')} {awaiting === 1 ? 'request is' : 'requests are'} still
          awaiting a result.
        </p>
      )}

      <div className="space-y-1 text-xs text-muted-foreground">
        <details>
          <summary className="cursor-pointer font-medium">How actions are counted</summary>
          <div className="mt-2 space-y-1">
            <p>
              Each attempted action is counted once using its latest result. Repeated timeouts are
              counted separately.
            </p>
            <p>
              Planned or blocked actions that were never attempted are excluded. Matching moderation
              events do not turn uncertain requests into confirmed requests.
            </p>
          </div>
        </details>
        <p>
          Last updated:{' '}
          <time dateTime={new Date(statistics.dataUpdatedAt).toISOString()}>
            {new Date(statistics.dataUpdatedAt).toLocaleTimeString()}
          </time>
        </p>
      </div>
    </section>
  );
}
