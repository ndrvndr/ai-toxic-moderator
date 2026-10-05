'use client';

import { Button } from '@/components/ui/button';
import { useSession } from '@/features/auth/hooks/use-session';
import { ApiError, getErrorMessage, GOOGLE_LOGIN_URL } from '@/lib/api-client';

import { useBroadcasts } from '../hooks/use-broadcasts';
import { AiOperationalStatusPanel } from './ai-operational-status-panel';
import { BroadcastList } from './broadcast-list';
import { LiveHeader } from './live-header';

export function LivePage() {
  const session = useSession();
  const accountId = session.data?.account.id;
  const broadcasts = useBroadcasts(session.data?.account.id);

  const reconnect =
    broadcasts.error instanceof ApiError && broadcasts.error.code === 'RECONNECT_REQUIRED';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <LiveHeader refreshing={broadcasts.isFetching} onRefresh={() => void broadcasts.refetch()} />

      {accountId &&
        session.data?.memberships
          .filter((membership) => ['OWNER', 'MODERATOR'].includes(membership.role))
          .map((membership) => (
            <AiOperationalStatusPanel
              key={`${accountId}:${membership.channel_id}`}
              accountId={accountId}
              channelId={membership.channel_id}
              channelName={membership.channel_name}
            />
          ))}

      {broadcasts.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading broadcasts…
        </p>
      )}

      {broadcasts.isError && (
        <div className="space-y-4 rounded-lg border p-5">
          <p role="alert" className="text-sm text-destructive">
            {getErrorMessage(broadcasts.error)}
          </p>

          {reconnect ? (
            <form action={GOOGLE_LOGIN_URL} method="get">
              <Button type="submit">Reconnect Google</Button>
            </form>
          ) : (
            <Button disabled={broadcasts.isFetching} onClick={() => void broadcasts.refetch()}>
              Try again
            </Button>
          )}
        </div>
      )}

      {broadcasts.isSuccess && (
        <BroadcastList broadcasts={broadcasts.data.items} truncated={broadcasts.data.truncated} />
      )}
    </div>
  );
}
