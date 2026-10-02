import { savedSession } from '@moderator/contracts';

import { apiRequest } from '@/lib/api-client';

export async function getHistorySession(sessionId: string, signal: AbortSignal) {
  return savedSession.parse(
    await apiRequest(`/v1/youtube/sessions/${encodeURIComponent(sessionId)}`, { signal }),
  );
}
