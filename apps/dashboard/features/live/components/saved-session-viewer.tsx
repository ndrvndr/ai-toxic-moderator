'use client';

import type { SavedSession } from '@moderator/contracts';

import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/api-client';

import { useLiveEvents } from '../hooks/use-live-events';
import { useMonitoring } from '../hooks/use-monitoring';
import { LiveChatPanel } from './live-chat-panel';

type SavedSessionViewerProps = {
  accountId: string;
  session: SavedSession;
};

export function SavedSessionViewer({ accountId, session }: SavedSessionViewerProps) {
  const { monitoring } = useMonitoring(accountId, session.youtube_broadcast_id);

  const connectionStatus = useLiveEvents({
    accountId,
    broadcastId: session.youtube_broadcast_id,
    channelId: session.channel_id,
    sessionId: session.session_id,
  });

  if (monitoring.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading saved monitoring session…
      </p>
    );
  }

  if (monitoring.isError) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">
          {getErrorMessage(monitoring.error)}
        </p>
        <Button
          variant="outline"
          disabled={monitoring.isFetching}
          onClick={() => void monitoring.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  const run = monitoring.data?.run;

  if (!run || run.channel_id !== session.channel_id || run.session_id !== session.session_id) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        No accessible monitoring run is available for this saved session.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">Monitoring: {run.status}</p>

      <LiveChatPanel accountId={accountId} run={run} connectionStatus={connectionStatus} />
    </div>
  );
}
