'use client';
import { Disclosure } from '@/components/disclosure';
import { Alert } from '@/components/ui/alert';

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

        <Alert role="alert" className="text-sm text-destructive">
          {unavailable
            ? 'Statistics are unavailable. Check your session and access permissions.'
            : getErrorMessage(statistics.error)}
        </Alert>

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
    { label: 'No match in text checks', value: data.allowed_messages },
    { label: 'Flagged by text checks', value: data.flagged_messages },
    { label: 'Checks failed', value: data.error_messages },
    { label: 'No text check', value: data.unevaluated_messages },
  ];

  return (
    <section
      aria-label="Message statistics"
      className="space-y-5 rounded-2xl border bg-card p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Your chat at a glance</h2>

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
          <div key={metric.label} className="rounded-xl bg-muted/40 p-4">
            <dt className="text-sm text-muted-foreground">{metric.label}</dt>
            <dd className="mt-2 text-2xl font-semibold tabular-nums">
              {metric.value.toLocaleString('en-US')}
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-xs leading-5 text-muted-foreground">
        These counts cover saved text messages and their blacklist checks, including historical rule
        results. AI ratings and action results are separate; a non-match does not mean no action was
        taken.
      </p>
      <Disclosure className="rounded-lg border p-4" title={<>Why messages were flagged</>}>
        <div className="mt-4">
          <HistoryFlaggedReasons reasons={data.flagged_reasons} />
        </div>
      </Disclosure>

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          Each saved text message is counted once. YouTube system events are excluded. Counts
          refresh when chat updates arrive.
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
