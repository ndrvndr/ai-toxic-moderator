'use client';
import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError, apiRequest } from '@/lib/api-client';
import { historySessionsPage, type SavedSession } from '@moderator/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export function useHistoryPage(
  accountId: string,
  search: string,
  status: SavedSession['latest_status'] | undefined,
  page: number,
  take: number,
) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['history-page', accountId, search.trim(), status ?? '', page, take],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ page: String(page), take: String(take) });
      if (search.trim()) query.set('q', search.trim());
      if (status) query.set('status', status);
      try {
        return historySessionsPage.parse(
          await apiRequest(`/v1/youtube/sessions/history-page?${query}`, { signal }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 401)
          void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        throw error;
      }
    },
    retry: false,
  });
}
