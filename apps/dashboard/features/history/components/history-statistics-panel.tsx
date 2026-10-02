'use client';

import { Button } from '@/components/ui/button';
import { ApiError, getErrorMessage } from '@/lib/api-client';

import { useHistoryStatistics } from '../hooks/use-history-statistics';
import { HistoryFlaggedReasons } from './history-flagged-reasons';

type HistoryStatisticsPanelProps = {
  accountId: string;
  sessionId: string;
};

export function HistoryStatisticsPanel({ accountId, sessionId }: HistoryStatisticsPanelProps) {
  const statistics = useHistoryStatistics(accountId, sessionId);

  if (statistics.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading message statistics…
      </p>
    );
  }

  if (statistics.isError) {
    const unavailable =
      statistics.error instanceof ApiError &&
      [401, 403, 404, 422].includes(statistics.error.status);

    return (
      <section aria-label="Message statistics" className="space-y-3 rounded-lg border p-5">
        <h2 className="font-semibold">Message statistics</h2>

        <p role="alert" className="text-sm text-destructive">
          {unavailable
            ? 'Statistics are unavailable. Check your session and access permissions.'
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
  const metrics = [
    { label: 'Total messages', value: data.total_messages },
    { label: 'Allowed', value: data.allowed_messages },
    { label: 'Flagged', value: data.flagged_messages },
    { label: 'Evaluation errors', value: data.error_messages },
    { label: 'Not evaluated', value: data.unevaluated_messages },
  ];

  return (
    <section aria-label="Message statistics" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Message statistics</h2>

        <Button
          variant="outline"
          disabled={statistics.isFetching}
          onClick={() => void statistics.refetch()}
        >
          {statistics.isFetching ? 'Refreshing…' : 'Refresh statistics'}
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-lg border bg-card p-4">
            <dt className="text-sm text-muted-foreground">{metric.label}</dt>
            <dd className="mt-2 text-2xl font-semibold tabular-nums">
              {metric.value.toLocaleString('en-US')}
            </dd>
          </div>
        ))}
      </dl>

      <HistoryFlaggedReasons reasons={data.flagged_reasons} />

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          Counts cover unique text messages stored during monitoring. Moderation events are
          excluded. Flagged includes messages requiring review or action.
        </p>
        <p>
          Statistics update when live chat updates are received. You can also refresh them manually.
        </p>
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
