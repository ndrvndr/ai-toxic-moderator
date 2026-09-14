import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import type { Broadcast } from '../api/broadcasts-api';

export function BroadcastCard({ broadcast }: { broadcast: Broadcast }) {
  const descriptionId = `monitoring-${broadcast.youtube_broadcast_id}`;

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

        <Button disabled aria-describedby={descriptionId}>
          Start Monitoring
        </Button>

        <p id={descriptionId} className="text-xs leading-5 text-muted-foreground">
          Automatic monitoring is not available yet.
        </p>
      </CardContent>
    </Card>
  );
}
