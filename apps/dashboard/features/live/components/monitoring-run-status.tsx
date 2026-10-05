import type { MonitoringRun } from '@moderator/contracts';

const failures: Record<string, [string, string]> = {
  YOUTUBE_QUOTA_EXCEEDED: [
    'Monitoring stopped: YouTube quota exhausted',
    'The app has reached its YouTube usage limit. This session will not retry automatically. When usage is available again, start monitoring if your stream is still live.',
  ],
  RECONNECT_REQUIRED: [
    'Monitoring stopped: reconnect Google',
    'Reconnect your Google account, then start a new monitoring session.',
  ],
  YOUTUBE_FORBIDDEN: [
    'Monitoring stopped: YouTube access denied',
    'The connected Google account cannot access this chat. Check that you’re using the right account before trying again.',
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
    'Monitoring stopped: chat could not resume',
    'We couldn’t continue from the last saved chat position. Start a new monitoring session to try again.',
  ],
  INVALID_PROVIDER_RESPONSE: [
    'Monitoring stopped: unexpected YouTube response',
    'YouTube returned chat data the app couldn’t read. Try again later.',
  ],
  INVALID_REQUEST: [
    'Monitoring stopped: chat request rejected',
    'The app couldn’t request this chat. Check your Google connection before trying again.',
  ],
  RETRY_DELAY_UNSUPPORTED: [
    'Monitoring stopped: retry unavailable',
    'YouTube asked the app to wait longer than this session can handle. Try starting monitoring again later.',
  ],
  GOOGLE_UNAVAILABLE: [
    'Monitoring stopped: Google unavailable',
    'The app tried reconnecting to Google but couldn’t continue. Check your connection, then start monitoring again.',
  ],
  YOUTUBE_UNAVAILABLE: [
    'Monitoring stopped: YouTube unavailable',
    'The app tried reconnecting to YouTube but couldn’t continue. Try starting monitoring again later.',
  ],
  YOUTUBE_RATE_LIMITED: [
    'Monitoring stopped: YouTube rate limit',
    'YouTube is limiting requests. Wait a little before starting monitoring again.',
  ],
};
const retryable = ['GOOGLE_UNAVAILABLE', 'YOUTUBE_UNAVAILABLE', 'YOUTUBE_RATE_LIMITED'];

function describe(run: MonitoringRun | null): [string, string] {
  if (!run)
    return [
      'Monitoring not started',
      'Start monitoring to save chat and apply your moderation settings.',
    ];
  switch (run.status) {
    case 'STARTING':
      return [
        'Monitoring starting',
        'Preparing this session. Chat collection has not been confirmed yet.',
      ];
    case 'RUNNING':
      return run.last_error_code && retryable.includes(run.last_error_code)
        ? [
            'Monitoring retrying',
            'The app is trying to reconnect to YouTube. New messages may be delayed; this status does not confirm that new chat has been collected.',
          ]
        : [
            'Monitoring running',
            'This monitoring session has started. Check AI status and each message for moderation results.',
          ];
    case 'STOPPING':
      return [
        'Monitoring stopping',
        'Finishing this monitoring session. Your YouTube livestream will keep running.',
      ];
    case 'STOPPED':
      return run.stop_requested_at
        ? [
            'Monitoring stopped after a stop request',
            'Chat collection has stopped. Stored chat and moderation results remain available.',
          ]
        : [
            'Monitoring ended',
            'Chat collection has ended. The saved session does not identify the exact end reason. You can still review its chat and moderation results.',
          ];
    case 'FAILED':
      return run.last_error_code && Object.hasOwn(failures, run.last_error_code)
        ? failures[run.last_error_code]!
        : [
            'Monitoring stopped after an error',
            'The app couldn’t continue monitoring. Your saved chat remains available. Try again later.',
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
