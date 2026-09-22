import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import type { Broadcast } from '../api/broadcasts-api';
import { MonitoringControls } from './monitoring-controls';

export function BroadcastCard({ broadcast }: { broadcast: Broadcast }) {
  return (
    <Card>
      <CardHeader>
        <p className="text-xs font-semibold text-muted-foreground">LIVE</p>
        <CardTitle className="wrap-break-word">{broadcast.title}</CardTitle>
        <CardDescription className="break-all">
          Channel: {broadcast.youtube_channel_id}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <p className="text-sm">
          {broadcast.live_chat_available
            ? 'Live chat is available.'
            : 'Live chat is unavailable for this broadcast.'}
        </p>

        <MonitoringControls
          broadcastId={broadcast.youtube_broadcast_id}
          liveChatAvailable={broadcast.live_chat_available}
        />
      </CardContent>
    </Card>
  );
}
