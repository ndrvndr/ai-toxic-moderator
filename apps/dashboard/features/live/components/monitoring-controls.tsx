'use client';
import { Alert } from '@/components/ui/alert';

import { Button } from '@/components/ui/button';
import { useSession } from '@/features/auth/hooks/use-session';
import { getErrorMessage } from '@/lib/api-client';

import { useLiveEvents } from '../hooks/use-live-events';
import { useMonitoring } from '../hooks/use-monitoring';
import { LiveChatPanel } from './live-chat-panel';
import { MonitoringRunStatus } from './monitoring-run-status';

type MonitoringControlsProps = {
  broadcastId: string;
  liveChatAvailable: boolean;
};

export function MonitoringControls({ broadcastId, liveChatAvailable }: MonitoringControlsProps) {
  const session = useSession();
  const { monitoring, start, stop } = useMonitoring(session.data?.account.id, broadcastId);

  const run = monitoring.data?.run;
  const connectionStatus = useLiveEvents({
    accountId: session.data?.account.id,
    broadcastId,
    channelId: run?.channel_id,
    sessionId: run?.session_id,
  });
  const busy = start.isPending || stop.isPending;
  const active =
    run !== null && run !== undefined && ['STARTING', 'RUNNING', 'STOPPING'].includes(run.status);

  const error = start.error ?? stop.error ?? monitoring.error;

  function handleStart() {
    stop.reset();
    start.mutate();
  }

  function handleStop() {
    start.reset();
    stop.mutate();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 rounded-xl bg-muted/30 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          {monitoring.isPending || monitoring.isError ? (
            <p role="status" className="text-sm">
              {monitoring.isPending
                ? 'Loading monitoring status…'
                : 'Monitoring status is unavailable.'}
            </p>
          ) : (
            <MonitoringRunStatus run={run ?? null} />
          )}

          {error && (
            <Alert role="alert" className="text-sm text-destructive">
              {getErrorMessage(error)}
            </Alert>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {active ? (
            <Button
              variant="outline"
              disabled={busy || !monitoring.isSuccess || run.status === 'STOPPING'}
              onClick={handleStop}
            >
              {stop.isPending || run.status === 'STOPPING' ? 'Stopping…' : 'Stop Monitoring'}
            </Button>
          ) : (
            <Button
              disabled={busy || !monitoring.isSuccess || !session.data || !liveChatAvailable}
              onClick={handleStart}
            >
              {start.isPending ? 'Starting…' : 'Start Monitoring'}
            </Button>
          )}

          {monitoring.isError && (
            <Button
              variant="outline"
              disabled={monitoring.isFetching || busy}
              onClick={() => void monitoring.refetch()}
            >
              Refresh status
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        Monitoring saves your chat and uses the moderation settings saved when this session starts.
        Later settings changes apply to your next session. Stopping monitoring does not end your
        YouTube livestream.
      </p>

      {run && session.data && (
        <LiveChatPanel
          key={`${session.data.account.id}:${run.session_id}`}
          accountId={session.data.account.id}
          run={run}
          connectionStatus={connectionStatus}
        />
      )}
    </div>
  );
}
