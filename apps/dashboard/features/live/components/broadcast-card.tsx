import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import type { Broadcast } from '../api/broadcasts-api';
import { MonitoringControls } from './monitoring-controls';

export function BroadcastCard({ broadcast }: { broadcast: Broadcast }) {
  return (
    <Card>
      <CardHeader>
        <p className="text-xs font-semibold text-muted-foreground">LIVE</p>
        <CardTitle className="wrap-break-word">{broadcast.title}</CardTitle>
        <CardDescription>Choose when to start or stop monitoring this stream.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <p className="text-sm">
          {broadcast.live_chat_available
            ? 'Chat is ready to monitor.'
            : 'Chat is unavailable for this stream.'}
        </p>

        <MonitoringControls
          broadcastId={broadcast.youtube_broadcast_id}
          liveChatAvailable={broadcast.live_chat_available}
        />
      </CardContent>
    </Card>
  );
}
