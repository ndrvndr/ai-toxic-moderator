'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError } from '@/lib/api-client';

import { getSavedSessions } from '../api/saved-sessions-api';

export function useSavedSessions(accountId: string) {
  const queryClient = useQueryClient();

  return useInfiniteQuery({
    queryKey: ['saved-sessions', accountId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      try {
        return await getSavedSessions(pageParam, signal);
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
    refetchOnWindowFocus: true,
    retry: false,
  });
}
