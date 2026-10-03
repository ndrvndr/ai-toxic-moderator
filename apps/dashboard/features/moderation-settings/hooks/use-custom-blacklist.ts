'use client';

import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError } from '@/lib/api-client';
import type { CustomBlacklistUpdate } from '@moderator/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getCustomBlacklist, saveCustomBlacklist } from '../api/custom-blacklist-api';

export const customBlacklistKey = (accountId: string, channelId: string) =>
  ['custom-blacklist', accountId, channelId.toLowerCase()] as const;

export const isBlacklistAccessError = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);

export function useCustomBlacklist(accountId: string, channelId: string) {
  const client = useQueryClient();
  const key = customBlacklistKey(accountId, channelId);
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      try {
        return await getCustomBlacklist(channelId, signal);
      } catch (error) {
        if (isBlacklistAccessError(error)) {
          client.setQueryData(key, null);
          void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
}

export function useSaveCustomBlacklist(accountId: string, channelId: string) {
  const client = useQueryClient();
  const key = customBlacklistKey(accountId, channelId);
  return useMutation({
    mutationKey: ['save-custom-blacklist', accountId, channelId],
    mutationFn: (input: CustomBlacklistUpdate) => saveCustomBlacklist(channelId, input),
    retry: false,
    onSuccess: (record) => client.setQueryData(key, record),
    onError: async (error) => {
      if (isBlacklistAccessError(error)) {
        await client.cancelQueries({ queryKey: key, exact: true });
        client.setQueryData(key, null);
        void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
    },
  });
}
