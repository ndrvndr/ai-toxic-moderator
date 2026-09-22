import { savedSessionsPage } from '@moderator/contracts';

import { apiRequest } from '@/lib/api-client';

export async function getSavedSessions(cursor: string | undefined, signal: AbortSignal) {
  const query = new URLSearchParams({ limit: '20' });

  if (cursor) {
    query.set('cursor', cursor);
  }

  return savedSessionsPage.parse(await apiRequest(`/v1/youtube/sessions?${query}`, { signal }));
}
