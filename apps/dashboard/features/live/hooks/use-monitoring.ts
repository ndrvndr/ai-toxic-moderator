'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError } from '@/lib/api-client';

import { getLatestMonitoring, startMonitoring, stopMonitoring } from '../api/monitoring-api';

export function useMonitoring(accountId: string | undefined, broadcastId: string) {
  const queryClient = useQueryClient();
  const requestKey = useRef<string | null>(null);
  const queryKey = ['monitoring', accountId, broadcastId] as const;

  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      void queryClient.invalidateQueries({
        queryKey: SESSION_QUERY_KEY,
      });
    }
  }

  const monitoring = useQuery({
    queryKey,
    enabled: Boolean(accountId),
    queryFn: async ({ signal }) => {
      try {
        return await getLatestMonitoring(broadcastId, signal);
      } catch (error) {
        handleError(error);
        throw error;
      }
    },
    refetchInterval: (query) => (query.state.status === 'error' ? false : 2000),
    refetchOnWindowFocus: true,
    retry: false,
  });

  const start = useMutation({
    mutationFn: async () => {
      requestKey.current ??= crypto.randomUUID();

      return startMonitoring(broadcastId, requestKey.current);
    },
    onSuccess: async (response) => {
      requestKey.current = null;

      await queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData(queryKey, { run: response.run });

      // Starting may create a new channel membership.
      void queryClient.invalidateQueries({
        queryKey: SESSION_QUERY_KEY,
      });
    },
    onError: handleError,
    retry: false,
  });

  const stop = useMutation({
    mutationFn: async () => {
      const run = monitoring.data?.run;

      if (!run) throw new Error('No monitoring run is selected.');

      return stopMonitoring(run.channel_id, run.id);
    },
    onSuccess: async (response) => {
      await queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData(queryKey, { run: response.run });
    },
    onError: handleError,
    retry: false,
  });

  return { monitoring, start, stop };
}
