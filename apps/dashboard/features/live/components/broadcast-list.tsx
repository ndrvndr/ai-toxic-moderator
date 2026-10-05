import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import type { Broadcast } from '../api/broadcasts-api';
import { BroadcastCard } from './broadcast-card';

type BroadcastListProps = {
  broadcasts: Broadcast[];
  truncated: boolean;
};

export function BroadcastList({ broadcasts, truncated }: BroadcastListProps) {
  return (
    <section aria-label="Active broadcasts" className="space-y-4">
      {truncated && (
        <p role="status" className="rounded-lg border bg-muted/40 p-4 text-sm">
          Results are incomplete. YouTube has additional pages, so your active broadcast may not
          appear in this list.
        </p>
      )}

      {broadcasts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {truncated ? 'No active broadcasts in the checked results' : 'No active broadcasts'}
            </CardTitle>
            <CardDescription>
              Start a broadcast in YouTube Studio, then refresh this list. Make sure you are using
              the correct Google account.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-4">
          {broadcasts.map((broadcast) => (
            <BroadcastCard key={broadcast.youtube_broadcast_id} broadcast={broadcast} />
          ))}
        </div>
      )}
    </section>
  );
}
