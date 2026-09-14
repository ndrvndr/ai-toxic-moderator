'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError } from '@/lib/api-client';

import { getBroadcasts } from '../api/broadcasts-api';

export function useBroadcasts(accountId: string | undefined) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ['youtube', 'broadcasts', accountId],
    enabled: Boolean(accountId),
    queryFn: async ({ signal }) => {
      try {
        return await getBroadcasts(signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          queryClient.setQueryData(SESSION_QUERY_KEY, null);
        }

        throw error;
      }
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
