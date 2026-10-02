'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError } from '@/lib/api-client';

import { getHistoryActionStatistics } from '../api/history-api';

export function useHistoryActionStatistics(accountId: string, sessionId: string) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ['history-action-statistics', accountId, sessionId],
    queryFn: async ({ signal }) => {
      try {
        return await getHistoryActionStatistics(sessionId, signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          void queryClient.invalidateQueries({
            queryKey: SESSION_QUERY_KEY,
          });
        }

        throw error;
      }
    },
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    retry: false,
  });
}
