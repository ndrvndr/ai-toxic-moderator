'use client';
import { Alert } from '@/components/ui/alert';

import type { ChatObservation, MonitoringRun } from '@moderator/contracts';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useSession } from '@/features/auth/hooks/use-session';
import { getErrorMessage } from '@/lib/api-client';

import { useLiveChat } from '../hooks/use-live-chat';
import type { LiveConnectionStatus } from '../hooks/use-live-events';
import type { ChatFilters } from '../lib/chat-filters';
import { ChatFilterControls } from './chat-filters';
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

export function LiveChatPanel(props: LiveChatPanelProps) {
  return (
    <LiveChatPanelContent
      key={`${props.accountId}:${props.run.channel_id}:${props.run.session_id}`}
      {...props}
    />
  );
}

function LiveChatPanelContent({ accountId, run, connectionStatus }: LiveChatPanelProps) {
  const session = useSession();
  const owner =
    !session.isError &&
    session.data?.account.id === accountId &&
    session.data.memberships.some(
      (membership) => membership.channel_id === run.channel_id && membership.role === 'OWNER',
    );
  const [filters, setFilters] = useState<ChatFilters>({});
  const chat = useLiveChat(accountId, run, connectionStatus, filters);
  const hasFilters = Boolean(filters.outcome || filters.category);
  const active = ['STARTING', 'RUNNING', 'STOPPING'].includes(run.status);

  if (connectionStatus === 'unauthenticated' || connectionStatus === 'forbidden') {
    return (
      <section aria-label="Livestream chat" className="border-t pt-4">
        <Alert role="alert" className="text-sm text-destructive">
          {connectionLabels[connectionStatus]}
        </Alert>
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
            Newest first ·{' '}
            {run.status === 'STARTING'
              ? 'Monitoring starting'
              : run.status === 'STOPPING'
                ? 'Monitoring stopping'
                : active
                  ? 'Monitoring running'
                  : 'Monitoring ended'}
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

      <ChatFilterControls filters={filters} onChange={setFilters} />

      {chat.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading chat…
        </p>
      )}

      {chat.isError && (
        <div className="space-y-2">
          <Alert role="alert" className="text-sm text-destructive">
            {getErrorMessage(chat.error)}
          </Alert>

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
          {hasFilters
            ? 'No chat items match these filters. Try another combination or clear the filters.'
            : active
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
            className="max-h-[65vh] min-h-64 overflow-y-auto border-y bg-background"
          >
            <ol>
              {messages.map((message) => (
                <ChatMessage
                  key={message.external_message_id}
                  message={message}
                  compact
                  unbanScope={{
                    accountId,
                    channelId: run.channel_id,
                    sessionId: run.session_id,
                    owner: Boolean(owner),
                  }}
                />
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
