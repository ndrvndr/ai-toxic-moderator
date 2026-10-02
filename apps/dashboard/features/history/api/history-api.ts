import { historyStatistics, savedSession } from '@moderator/contracts';

import { apiRequest } from '@/lib/api-client';

export async function getHistorySession(sessionId: string, signal: AbortSignal) {
  return savedSession.parse(
    await apiRequest(`/v1/youtube/sessions/${encodeURIComponent(sessionId)}`, { signal }),
  );
}

export async function getHistoryStatistics(sessionId: string, signal: AbortSignal) {
  const result = historyStatistics.parse(
    await apiRequest(`/v1/youtube/sessions/${encodeURIComponent(sessionId)}/statistics`, {
      signal,
    }),
  );

  if (result.session_id !== sessionId) {
    throw new Error('History statistics session mismatch.');
  }

  return result;
}
