import { savedSessionsPage } from '@moderator/contracts';

import { apiRequest } from '@/lib/api-client';
import type { SavedSession } from '@moderator/contracts/src/saved-sessions';

export async function getSavedSessions(
  cursor: string | undefined,
  signal: AbortSignal,
  search = '',
  status?: NonNullable<SavedSession['latest_status']>,
) {
  const query = new URLSearchParams({ limit: '20' });
  const q = search.trim();

  if (cursor) {
    query.set('cursor', cursor);
  }

  if (q) {
    query.set('q', q);
  }

  if (status) {
    query.set('status', status);
  }

  return savedSessionsPage.parse(await apiRequest(`/v1/youtube/sessions?${query}`, { signal }));
}
