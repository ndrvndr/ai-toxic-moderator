'use client';
import { Disclosure } from '@/components/disclosure';

import type { AiOperationalStatusResponse } from '@moderator/contracts';
import Link from 'next/link';
import { useState } from 'react';

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

type Props = { accountId: string; channelId: string; channelName?: string };

export function AiOperationalStatusPanel(props: Props) {
  return <StatusContent key={`${props.accountId}:${props.channelId}`} {...props} />;
}

function StatusContent({ accountId, channelId, channelName }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const query = useAiOperationalStatus(accountId, channelId);
  const data = query.data;
  const unavailable = query.isError;
  const checking = query.isPending || !data;
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
        <Disclosure
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          className="text-xs text-muted-foreground"
          title={<>Status details</>}
        >
          <dl className="mt-2 space-y-1 wrap-break-word">
            <div>
              <dt className="inline font-medium">Channel: </dt>
              <dd className="inline">{channelName ?? 'Your connected channel'}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Last checked: </dt>
              <dd className="inline">
                <time dateTime={data.checked_at}>{new Date(data.checked_at).toLocaleString()}</time>
              </dd>
            </div>
            {data.report && (
              <>
                <div>
                  <dt className="inline font-medium">Last reported status: </dt>
                  <dd className="inline">
                    {
                      {
                        ACTIVE: 'Checking chat',
                        WAITING: 'Waiting for a stream',
                        DISABLED: 'AI switched off',
                        MODEL_MISMATCH: 'AI setup needs attention',
                        CAPACITY_EXCEEDED: 'Too many streams for AI',
                        ERROR: 'AI encountered a problem',
                      }[data.report.status]
                    }
                  </dd>
                </div>
                {data.report.error_code && (
                  <div>
                    <dt className="inline font-medium">Issue: </dt>
                    <dd className="inline">
                      {
                        {
                          MODEL_UNAVAILABLE: 'The AI model is unavailable.',
                          INFERENCE_FAILED: 'AI could not check a message.',
                          INFERENCE_TIMEOUT: 'AI took too long to check a message.',
                          INVALID_OUTPUT: 'AI returned an unusable result.',
                          DATABASE_UNAVAILABLE: 'Chat storage is temporarily unavailable.',
                          PIPELINE_FAILED: 'AI processing could not complete.',
                        }[data.report.error_code]
                      }
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="inline font-medium">Last update from AI: </dt>
                  <dd className="inline">
                    <time dateTime={data.report.heartbeat_at}>
                      {new Date(data.report.heartbeat_at).toLocaleString()}
                    </time>
                  </dd>
                </div>
                {data.report.session_id && (
                  <div>
                    <dt className="inline font-medium">Monitored stream: </dt>
                    <dd className="inline">
                      <Link
                        href={`/history/${data.report.session_id}`}
                        className="underline underline-offset-4"
                      >
                        View stream in History
                      </Link>
                    </dd>
                  </div>
                )}
              </>
            )}
          </dl>
        </Disclosure>
      )}
    </section>
  );
}
