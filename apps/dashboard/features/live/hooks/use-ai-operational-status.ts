'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError } from '@/lib/api-client';

import { getAiOperationalStatus } from '../api/ai-operational-status-api';

export function useAiOperationalStatus(accountId: string, channelId: string) {
  const client = useQueryClient();
  const queryKey = ['ai-operational-status', accountId, channelId] as const;
  return useQuery({
    queryKey,
    enabled: Boolean(accountId && channelId),
    queryFn: async ({ signal }) => {
      try {
        return await getAiOperationalStatus(channelId, signal);
      } catch (error) {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          // Clear sensitive cached reports before surfacing lost access.
          client.setQueryData(queryKey, null);
          if (error.status === 401) void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        }
        throw error;
      }
    },
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.error instanceof ApiError && [401, 403, 404].includes(query.state.error.status)
        ? false
        : 5_000,
    refetchIntervalInBackground: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    retry: false,
  });
}
