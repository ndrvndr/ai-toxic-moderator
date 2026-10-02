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
    { label: 'Delete message', counts: data.delete },
    { label: 'Timeout', counts: data.timeout },
    { label: 'Ban', counts: data.ban },
  ];

  const hasAttempts = actions.some(({ counts }) => counts.total > 0);

  return (
    <section aria-label="Moderation action results" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Moderation action results</h2>

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
          <article key={label} className="space-y-4 rounded-lg border bg-card p-4">
            <h3 className="font-semibold">{label}</h3>

            <dl className="space-y-2">
              {outcomes.map(({ key, label: outcomeLabel }) => (
                <div key={key} className="flex justify-between gap-4 text-sm">
                  <dt className="text-muted-foreground">{outcomeLabel}</dt>
                  <dd className="font-medium tabular-nums">
                    {counts[key].toLocaleString('en-US')}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          Each execution with an attempt is counted once, using its latest attempt outcome. Repeated
          timeouts are counted separately.
        </p>
        <p>
          Pending or blocked executions without an attempt are excluded. Confirmed results do not
          indicate whether a restriction is still active.
        </p>
        <p>Unknown outcomes remain separate, even when a matching moderation event was observed.</p>
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
