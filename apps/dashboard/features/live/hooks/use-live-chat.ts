'use client';

import type { MonitoringRun } from '@moderator/contracts';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError } from '@/lib/api-client';

import { getChatPage } from '../api/chat-api';
import type { LiveConnectionStatus } from './use-live-events';

export function useLiveChat(
  accountId: string,
  run: MonitoringRun,
  connectionStatus: LiveConnectionStatus,
) {
  const queryClient = useQueryClient();
  const active = ['STARTING', 'RUNNING', 'STOPPING'].includes(run.status);

  const accessBlocked = connectionStatus === 'unauthenticated' || connectionStatus === 'forbidden';

  const query = useInfiniteQuery({
    queryKey: ['live-chat', accountId, run.channel_id, run.session_id],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      try {
        return await getChatPage({
          channelId: run.channel_id,
          sessionId: run.session_id,
          cursor: pageParam,
          signal,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          void queryClient.invalidateQueries({
            queryKey: SESSION_QUERY_KEY,
          });
        }

        throw error;
      }
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: (state) =>
      active && !accessBlocked && connectionStatus !== 'connected' && state.state.status !== 'error'
        ? 15_000
        : false,
    refetchOnWindowFocus: false,
    retry: false,
    enabled: !accessBlocked,
  });

  // Refresh after lifecycle transitions, including the final stopped state.
  useEffect(() => {
    if (accessBlocked) return;

    void queryClient.invalidateQueries({
      queryKey: ['live-chat', accountId, run.channel_id, run.session_id],
      exact: true,
    });
  }, [queryClient, accountId, run.channel_id, run.session_id, run.id, run.status, accessBlocked]);

  return query;
}
