'use client';

import type { ChatObservation, MonitoringRun } from '@moderator/contracts';

import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/api-client';

import { useLiveChat } from '../hooks/use-live-chat';
import type { LiveConnectionStatus } from '../hooks/use-live-events';
import { ChatMessage } from './chat-message';

type LiveChatPanelProps = {
  accountId: string;
  run: MonitoringRun;
  connectionStatus: LiveConnectionStatus;
};

const connectionLabels: Record<LiveConnectionStatus, string> = {
  idle: 'Live updates inactive',
  connecting: 'Connecting to live updates…',
  connected: 'Live updates connected',
  reconnecting: 'Reconnecting…',
  unauthenticated: 'Your session has expired. Please sign in again.',
  forbidden: 'You no longer have access to this chat.',
  unavailable: 'Live updates unavailable. Refresh the page to reconnect.',
};

export function LiveChatPanel({ accountId, run, connectionStatus }: LiveChatPanelProps) {
  const chat = useLiveChat(accountId, run, connectionStatus);
  const active = ['STARTING', 'RUNNING', 'STOPPING'].includes(run.status);

  if (connectionStatus === 'unauthenticated' || connectionStatus === 'forbidden') {
    return (
      <section aria-label="Livestream chat" className="border-t pt-4">
        <p role="alert" className="text-sm text-destructive">
          {connectionLabels[connectionStatus]}
        </p>
      </section>
    );
  }

  // Pages are newest first. Keep the newest loaded version of each resource.
  const latest = new Map<string, ChatObservation>();

  for (const page of chat.data?.pages ?? []) {
    for (const observation of page.items) {
      if (!latest.has(observation.external_message_id)) {
        latest.set(observation.external_message_id, observation);
      }
    }
  }

  const messages = [...latest.values()];

  return (
    <section aria-label="Livestream chat" className="space-y-3 border-t pt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Chat</h3>
          <p className="text-xs text-muted-foreground">
            Newest first · {active ? 'Monitoring active' : 'Monitoring ended'}
          </p>

          <p role="status" className="text-xs text-muted-foreground">
            {connectionLabels[connectionStatus]}
          </p>

          {active && ['connecting', 'reconnecting', 'unavailable'].includes(connectionStatus) && (
            <p className="text-xs text-muted-foreground">
              Chat refreshes every 15 seconds while live updates are disconnected.
            </p>
          )}
        </div>

        <Button
          size="sm"
          variant="outline"
          disabled={chat.isFetching}
          onClick={() => void chat.refetch()}
        >
          {chat.isRefetching ? 'Refreshing…' : 'Refresh chat'}
        </Button>
      </div>

      {chat.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading chat…
        </p>
      )}

      {chat.isError && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {getErrorMessage(chat.error)}
          </p>

          <Button
            size="sm"
            variant="outline"
            disabled={chat.isFetching}
            onClick={() => {
              if (chat.isFetchNextPageError) {
                void chat.fetchNextPage();
              } else {
                void chat.refetch();
              }
            }}
          >
            Try again
          </Button>
        </div>
      )}

      {chat.isSuccess && messages.length === 0 && (
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          {active
            ? 'No chat messages have been collected yet.'
            : 'No chat messages were collected for this livestream.'}
        </p>
      )}

      {messages.length > 0 && (
        <>
          <div
            role="region"
            aria-label="Chat messages, newest first"
            tabIndex={0}
            className="max-h-112 overflow-y-auto rounded-lg border"
          >
            <ol>
              {messages.map((message) => (
                <ChatMessage key={message.external_message_id} message={message} />
              ))}
            </ol>
          </div>

          <p className="text-xs text-muted-foreground">
            Showing {messages.length} loaded chat items.
          </p>
        </>
      )}

      {chat.hasNextPage && (
        <Button
          className="w-full"
          variant="outline"
          disabled={chat.isFetching}
          onClick={() => void chat.fetchNextPage()}
        >
          {chat.isFetchingNextPage ? 'Loading…' : 'Load older messages'}
        </Button>
      )}
    </section>
  );
}
