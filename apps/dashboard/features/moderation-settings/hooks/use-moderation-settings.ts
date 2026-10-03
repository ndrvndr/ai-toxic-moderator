'use client';

import type { ModerationSettingsUpdate } from '@moderator/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError } from '@/lib/api-client';

import {
  getModerationRuleCatalog,
  getModerationSettings,
  saveModerationSettings,
} from '../api/moderation-settings-api';

export const moderationSettingsKey = (accountId: string, channelId: string) =>
  ['moderation-settings', accountId, channelId] as const;

export function useModerationSettings(accountId: string, channelId: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: moderationSettingsKey(accountId, channelId),
    queryFn: async ({ signal }) => {
      try {
        return await getModerationSettings(channelId, signal);
      } catch (error) {
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
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

export function useModerationRuleCatalog(accountId: string, channelId: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['moderation-rule-catalog', accountId, channelId],
    queryFn: async ({ signal }) => {
      try {
        return await getModerationRuleCatalog(channelId, signal);
      } catch (error) {
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
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

export function useSaveModerationSettings(accountId: string, channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['save-moderation-settings', accountId, channelId],
    mutationFn: (input: ModerationSettingsUpdate) => saveModerationSettings(channelId, input),
    retry: false,
    onSuccess: (record) => client.setQueryData(moderationSettingsKey(accountId, channelId), record),
    onError: (error) => {
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
    },
  });
}
