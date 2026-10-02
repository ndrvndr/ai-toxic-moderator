'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { API_ORIGIN } from '@/lib/api-client';

import { consumeLiveFrame, type LivePosition } from '../lib/live-event-protocol';

export type LiveConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unauthenticated'
  | 'forbidden'
  | 'unavailable';

type LiveEventsOptions = {
  accountId: string | undefined;
  broadcastId: string;
  channelId: string | undefined;
  sessionId: string | undefined;
};

export function useLiveEvents({ accountId, broadcastId, channelId, sessionId }: LiveEventsOptions) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveConnectionStatus>('idle');

  useEffect(() => {
    if (!accountId || !channelId || !sessionId) {
      setStatus('idle');
      return;
    }

    const chatKey = ['live-chat', accountId, channelId, sessionId] as const;
    const monitoringKey = ['monitoring', accountId, broadcastId] as const;
    const statisticsKey = ['history-statistics', accountId, sessionId] as const;
    const actionStatisticsKey = ['history-action-statistics', accountId, sessionId] as const;

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let resetAttempted = false;
    let stopped = false;
    let refreshing = false;
    let dirtyChat = false;
    let dirtyMonitoring = false;

    let position: LivePosition = {
      cursor: null,
      ready: false,
    };

    function scheduleRefresh(wait = 200) {
      if (disposed || stopped || refreshing || refreshTimer !== undefined) {
        return;
      }

      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, wait);
    }

    async function refresh() {
      if (disposed || stopped || refreshing) return;

      refreshing = true;

      const chat = dirtyChat;
      const monitoring = dirtyMonitoring;
      dirtyChat = false;
      dirtyMonitoring = false;

      const results = await Promise.allSettled([
        chat
          ? queryClient.invalidateQueries(
              {
                predicate: ({ queryKey }) =>
                  (queryKey.length === 4 &&
                    queryKey[0] === 'live-chat' &&
                    queryKey[1] === accountId &&
                    queryKey[2] === channelId &&
                    queryKey[3] === sessionId) ||
                  (queryKey.length === 3 &&
                    (queryKey[0] === 'history-statistics' ||
                      queryKey[0] === 'history-action-statistics') &&
                    queryKey[1] === accountId &&
                    queryKey[2] === sessionId),
              },
              { throwOnError: true },
            )
          : Promise.resolve(),
        monitoring
          ? queryClient.invalidateQueries(
              { queryKey: monitoringKey, exact: true },
              { throwOnError: true },
            )
          : Promise.resolve(),
      ]);

      refreshing = false;

      if (disposed || stopped) return;

      const chatFailed = results[0]?.status === 'rejected';
      const monitoringFailed = results[1]?.status === 'rejected';

      dirtyChat ||= chatFailed;
      dirtyMonitoring ||= monitoringFailed;

      if (dirtyChat || dirtyMonitoring) {
        scheduleRefresh(chatFailed || monitoringFailed ? 2000 : 200);
      }
    }

    function clearHandshakeTimer() {
      clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    }

    function reconnect() {
      if (disposed || stopped) return;

      attempts += 1;

      if (attempts > 6) {
        setStatus('unavailable');
        return;
      }

      setStatus('reconnecting');

      const backoff = Math.min(30_000, 1000 * 2 ** (attempts - 1));
      const jitter = Math.floor(Math.random() * 500);

      retryTimer = setTimeout(connect, backoff + jitter);
    }

    function connect() {
      if (disposed || stopped) return;

      position = { ...position, ready: false };
      setStatus(attempts === 0 ? 'connecting' : 'reconnecting');

      const url = new URL('/v1/live', API_ORIGIN);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('channel_id', channelId!);
      url.searchParams.set('session_id', sessionId!);

      if (position.cursor !== null) {
        url.searchParams.set('after', position.cursor);
      }

      let current: WebSocket;

      try {
        current = new WebSocket(url);
      } catch {
        reconnect();
        return;
      }

      socket = current;

      handshakeTimer = setTimeout(() => {
        current.close();
      }, 20_000);

      current.onmessage = (event: MessageEvent<unknown>) => {
        if (disposed || stopped || socket !== current) return;

        try {
          const result = consumeLiveFrame(
            event.data,
            { channelId: channelId!, sessionId: sessionId! },
            position,
          );

          position = {
            cursor: result.cursor,
            ready: result.ready,
          };

          clearHandshakeTimer();
          attempts = 0;
          setStatus('connected');

          dirtyChat ||= result.refreshChat;
          dirtyMonitoring ||= result.refreshMonitoring;

          if (dirtyChat || dirtyMonitoring) {
            scheduleRefresh();
          }
        } catch {
          stopped = true;
          setStatus('unavailable');
          current.close(1000, 'Invalid live response.');
        }
      };

      current.onerror = () => {
        // The close event handles recovery; browser handshake errors have no body.
        current.close();
      };

      current.onclose = (event) => {
        clearHandshakeTimer();

        if (disposed || stopped || socket !== current) return;

        if (event.code === 4001) {
          stopped = true;
          setStatus('unauthenticated');
          void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
          void queryClient.cancelQueries({ queryKey: chatKey, exact: true });
          queryClient.removeQueries({ queryKey: chatKey, exact: true });
          void queryClient.resetQueries({
            queryKey: statisticsKey,
            exact: true,
          });
          void queryClient.resetQueries({
            queryKey: actionStatisticsKey,
            exact: true,
          });
          return;
        }

        if (event.code === 4003 || event.code === 4004) {
          stopped = true;
          setStatus('forbidden');

          void queryClient.cancelQueries({
            queryKey: chatKey,
            exact: true,
          });

          queryClient.removeQueries({
            queryKey: chatKey,
            exact: true,
          });

          void queryClient.resetQueries({
            queryKey: statisticsKey,
            exact: true,
          });

          void queryClient.resetQueries({
            queryKey: actionStatisticsKey,
            exact: true,
          });

          void queryClient.invalidateQueries({
            queryKey: SESSION_QUERY_KEY,
          });

          return;
        }

        if (event.code === 4000 && !resetAttempted) {
          resetAttempted = true;
          position = { cursor: null, ready: false };
        }

        if (!position.ready) {
          void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        }

        reconnect();
      };
    }

    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearTimeout(refreshTimer);
      clearHandshakeTimer();

      if (socket) {
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close(1000, 'Live view closed.');
      }
    };
  }, [queryClient, accountId, broadcastId, channelId, sessionId]);

  return status;
}
