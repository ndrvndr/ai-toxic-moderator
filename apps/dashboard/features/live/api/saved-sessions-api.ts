import { savedSessionsPage } from '@moderator/contracts';

import { apiRequest } from '@/lib/api-client';

export async function getSavedSessions(
  cursor: string | undefined,
  signal: AbortSignal,
  search = '',
) {
  const query = new URLSearchParams({ limit: '20' });
  const q = search.trim();

  if (cursor) {
    query.set('cursor', cursor);
  }

  if (q) {
    query.set('q', q);
  }

  return savedSessionsPage.parse(await apiRequest(`/v1/youtube/sessions?${query}`, { signal }));
}
