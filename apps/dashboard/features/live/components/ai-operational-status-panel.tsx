'use client';

import type { AiOperationalStatusResponse } from '@moderator/contracts';
import Link from 'next/link';

import { Button } from '@/components/ui/button';

import { useAiOperationalStatus } from '../hooks/use-ai-operational-status';

function describe(data: AiOperationalStatusResponse): [string, string] {
  if (data.availability === 'UNKNOWN')
    return ['AI status unknown', 'We haven’t received an AI status update for this channel yet.'];
  if (data.availability === 'STALE')
    return [
      'AI status out of date',
      'The latest AI update is too old to confirm that AI is checking chat. Check again shortly.',
    ];
  const report = data.report;
  switch (report.status) {
    case 'ACTIVE':
      return [
        'AI processing active',
        'AI processing is enabled for a selected stream. Check each message to see whether an action was confirmed by YouTube.',
      ];
    case 'DISABLED':
      return report.reason === 'RUN_AI_DISABLED'
        ? [
            'AI off for this session',
            'AI was off when monitoring started. Save your AI settings, then start a new monitoring session to use them.',
          ]
        : [
            'Automatic AI disabled',
            'AI is switched off in the app’s service configuration. Chat monitoring can still run.',
          ];
    case 'WAITING':
      return [
        'AI waiting for a stream',
        'AI has not selected a stream to check. Start monitoring with AI enabled in your settings.',
      ];
    case 'MODEL_MISMATCH':
      return [
        'AI setup needs attention',
        'This session’s AI settings use a different model from the app. AI cannot check this session until the setup matches.',
      ];
    case 'CAPACITY_EXCEEDED':
      return [
        'Too many streams for AI',
        'AI can check one eligible stream at a time. Stop monitoring the other streams to continue.',
      ];
    case 'ERROR':
      return [
        'AI needs attention',
        'AI encountered a problem. New AI results may be unavailable. Check again shortly; the results already saved on messages remain available.',
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
        'We couldn’t check AI right now. Try again to get its latest status.',
      ]
    : checking || !data
      ? ['Checking AI status…', 'Getting the latest AI update.']
      : describe(data);

  return (
    <section
      aria-label="Automatic AI status"
      className="space-y-3 rounded-xl border bg-muted/20 p-4 sm:p-5"
    >
      <p className="text-sm font-medium" role="status">
        {label}
      </p>
      <p className="text-xs leading-5 text-muted-foreground">{explanation}</p>
      <Link
        href="/settings/moderation"
        className="inline-block text-xs font-medium underline underline-offset-4"
      >
        Review moderation settings
      </Link>
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
          <summary className="cursor-pointer">Technical details</summary>
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
                {data.report.error_code && (
                  <div>
                    <dt className="inline font-medium">Error code: </dt>
                    <dd className="inline">{data.report.error_code}</dd>
                  </div>
                )}
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
