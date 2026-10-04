'use client';

import type { AiOperationalStatusResponse } from '@moderator/contracts';

import { Button } from '@/components/ui/button';

import { useAiOperationalStatus } from '../hooks/use-ai-operational-status';

function describe(data: AiOperationalStatusResponse): [string, string] {
  if (data.availability === 'UNKNOWN')
    return ['AI status unknown', 'No worker report has been received for this channel.'];
  if (data.availability === 'STALE')
    return [
      'AI worker not reporting',
      'The last heartbeat has expired. Current AI processing cannot be confirmed.',
    ];
  const report = data.report;
  switch (report.status) {
    case 'ACTIVE':
      return [
        'AI processing active',
        'The worker has selected an eligible run. Moderation execution outcomes appear separately on messages.',
      ];
    case 'DISABLED':
      return report.reason === 'RUN_AI_DISABLED'
        ? [
            'AI disabled for this run',
            'This run captured disabled AI settings. Changes in Settings apply to a new run.',
          ]
        : ['Automatic AI disabled', 'Automatic AI is disabled in worker configuration.'];
    case 'WAITING':
      return ['AI waiting for a run', 'No eligible active monitoring run is selected.'];
    case 'MODEL_MISMATCH':
      return [
        'AI model mismatch',
        'The model captured for this run differs from the worker model. AI processing is paused for this run.',
      ];
    case 'CAPACITY_EXCEEDED':
      return [
        'AI capacity exceeded',
        'More than one eligible run is active. This worker supports one eligible livestream at a time.',
      ];
    case 'ERROR':
      return [
        'AI processing error',
        `The worker reported ${report.error_code}. Check worker configuration and logs.`,
      ];
  }
}

export function AiOperationalStatusPanel({
  accountId,
  channelId,
}: {
  accountId: string;
  channelId: string;
}) {
  const query = useAiOperationalStatus(accountId, channelId);
  const data = query.data;
  const unavailable = query.isError;
  const checking = query.isPending || (query.isFetching && query.isStale);
  const [label, explanation] = unavailable
    ? [
        'AI status unavailable',
        'The status request failed or channel access changed. Current AI processing cannot be confirmed.',
      ]
    : checking || !data
      ? ['Checking AI status…', 'Reading the latest worker report.']
      : describe(data);

  return (
    <section aria-label="Automatic AI status" className="space-y-2 rounded-lg border p-4">
      <p className="text-sm font-medium" role="status">
        {label}
      </p>
      <p className="text-xs leading-5 text-muted-foreground">{explanation}</p>
      {unavailable && (
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Retry AI status
        </Button>
      )}
      {!unavailable && !checking && data && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Worker report details</summary>
          <dl className="mt-2 space-y-1 wrap-break-word">
            <div>
              <dt className="inline font-medium">Channel: </dt>
              <dd className="inline">{channelId}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Checked: </dt>
              <dd className="inline">
                <time dateTime={data.checked_at}>{new Date(data.checked_at).toLocaleString()}</time>
              </dd>
            </div>
            {data.report && (
              <>
                <div>
                  <dt className="inline font-medium">Last reported state: </dt>
                  <dd className="inline">{data.report.status}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Heartbeat: </dt>
                  <dd className="inline">
                    <time dateTime={data.report.heartbeat_at}>
                      {new Date(data.report.heartbeat_at).toLocaleString()}
                    </time>
                  </dd>
                </div>
                {data.report.run_id && (
                  <div>
                    <dt className="inline font-medium">Reported run: </dt>
                    <dd className="inline">{data.report.run_id}</dd>
                  </div>
                )}
              </>
            )}
          </dl>
        </details>
      )}
    </section>
  );
}
