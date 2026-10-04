'use client';

import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError } from '@/lib/api-client';
import type { AiModerationSettingsUpdate } from '@moderator/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAiModerationSettings,
  saveAiModerationSettings,
} from '../api/ai-moderation-settings-api';

export const aiModerationSettingsKey = (accountId: string, channelId: string) =>
  ['ai-moderation-settings', accountId, channelId.toLowerCase()] as const;

export const isAiSettingsAccessError = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);

export function useAiModerationSettings(accountId: string, channelId: string) {
  const client = useQueryClient();
  const key = aiModerationSettingsKey(accountId, channelId);
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      try {
        return await getAiModerationSettings(channelId, signal);
      } catch (error) {
        if (isAiSettingsAccessError(error)) {
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

export function useSaveAiModerationSettings(accountId: string, channelId: string) {
  const client = useQueryClient();
  const key = aiModerationSettingsKey(accountId, channelId);
  return useMutation({
    mutationKey: ['save-ai-moderation-settings', accountId, channelId.toLowerCase()],
    mutationFn: (input: AiModerationSettingsUpdate) => saveAiModerationSettings(channelId, input),
    retry: false,
    onSuccess: async (record) => {
      await client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData(key, record);
    },
    onError: async (error) => {
      if (isAiSettingsAccessError(error)) {
        await client.cancelQueries({ queryKey: key, exact: true });
        client.setQueryData(key, null);
        void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
    },
  });
}
