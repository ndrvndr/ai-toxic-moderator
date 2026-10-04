import type { MonitoringRun } from '@moderator/contracts';

const failures: Record<string, [string, string]> = {
  YOUTUBE_QUOTA_EXCEEDED: [
    'Monitoring stopped: YouTube quota exhausted',
    'YouTube rejected chat collection because the project quota is exhausted. This run will not retry automatically. Wait until quota is available, then start monitoring again if the broadcast is still active.',
  ],
  RECONNECT_REQUIRED: [
    'Monitoring stopped: reconnect Google',
    'The Google connection is no longer usable. Reconnect your Google account, then start a new monitoring run.',
  ],
  YOUTUBE_FORBIDDEN: [
    'Monitoring stopped: YouTube access denied',
    'YouTube denied chat access. Check the connected account and channel permissions before starting monitoring again.',
  ],
  LIVE_CHAT_DISABLED: [
    'Monitoring stopped: live chat disabled',
    'YouTube reports that live chat is disabled for this broadcast. Enable chat before starting monitoring again.',
  ],
  LIVE_CHAT_NOT_FOUND: [
    'Monitoring stopped: live chat unavailable',
    'YouTube could not find this live chat. Check whether the broadcast and its chat are still available.',
  ],
  INVALID_PAGE_TOKEN: [
    'Monitoring stopped: chat checkpoint rejected',
    'YouTube rejected the saved chat checkpoint. This run has ended; check worker logs before starting monitoring again.',
  ],
  INVALID_PROVIDER_RESPONSE: [
    'Monitoring stopped: unexpected YouTube response',
    'The worker could not validate the chat response. Check worker logs before starting monitoring again.',
  ],
  INVALID_REQUEST: [
    'Monitoring stopped: chat request rejected',
    'The chat request could not be sent successfully. Check worker configuration and logs before starting monitoring again.',
  ],
  RETRY_DELAY_UNSUPPORTED: [
    'Monitoring stopped: unsupported retry delay',
    'The provider requested a retry delay the worker cannot safely schedule. Check worker logs before starting monitoring again.',
  ],
  GOOGLE_UNAVAILABLE: [
    'Monitoring stopped: Google unavailable',
    'The worker exhausted its automatic retries after Google requests failed. Check connectivity before starting monitoring again.',
  ],
  YOUTUBE_UNAVAILABLE: [
    'Monitoring stopped: YouTube unavailable',
    'The worker exhausted its automatic retries after YouTube requests failed. Check connectivity before starting monitoring again.',
  ],
  YOUTUBE_RATE_LIMITED: [
    'Monitoring stopped: YouTube rate limit',
    'The worker exhausted its automatic retries after YouTube rate limits. Wait before starting monitoring again.',
  ],
};
const retryable = ['GOOGLE_UNAVAILABLE', 'YOUTUBE_UNAVAILABLE', 'YOUTUBE_RATE_LIMITED'];

function describe(run: MonitoringRun | null): [string, string] {
  if (!run)
    return ['Monitoring not started', 'Start monitoring to collect chat for this broadcast.'];
  switch (run.status) {
    case 'STARTING':
      return [
        'Monitoring starting',
        'The run is queued for the worker. Chat collection has not been confirmed yet.',
      ];
    case 'RUNNING':
      return run.last_error_code && retryable.includes(run.last_error_code)
        ? [
            'Monitoring retrying',
            'The last provider request failed. The worker schedules retries automatically; this status does not confirm that new chat has been collected.',
          ]
        : [
            'Monitoring running',
            'The worker started this run. AI health and individual moderation outcomes are shown separately.',
          ];
    case 'STOPPING':
      return [
        'Monitoring stopping',
        'A stop was requested. Waiting for the worker to finish this run.',
      ];
    case 'STOPPED':
      return run.stop_requested_at
        ? [
            'Monitoring stopped after a stop request',
            'Chat collection has stopped. Stored chat and moderation results remain available.',
          ]
        : [
            'Monitoring ended',
            'Chat collection has ended without a recorded stop request. The saved run does not identify the exact end reason. Stored results remain available.',
          ];
    case 'FAILED':
      return run.last_error_code && Object.hasOwn(failures, run.last_error_code)
        ? failures[run.last_error_code]!
        : [
            'Monitoring stopped after an error',
            'This run failed. Check worker logs before starting monitoring again.',
          ];
  }
}

export function MonitoringRunStatus({ run }: { run: MonitoringRun | null }) {
  const [label, explanation] = describe(run);
  return (
    <section aria-label="Monitoring lifecycle" className="space-y-1">
      <p
        role="status"
        className={`text-sm font-medium${run?.status === 'FAILED' ? ' text-destructive' : ''}`}
      >
        {label}
      </p>
      <p className="text-xs leading-5 text-muted-foreground">{explanation}</p>
    </section>
  );
}
