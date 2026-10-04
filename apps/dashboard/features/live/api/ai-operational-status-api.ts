import { aiOperationalStatusResponse } from '@moderator/contracts';

import { apiRequest } from '@/lib/api-client';

export async function getAiOperationalStatus(channelId: string, signal?: AbortSignal) {
  const response = aiOperationalStatusResponse.parse(
    await apiRequest(`/v1/channels/${encodeURIComponent(channelId)}/ai/status`, { signal }),
  );
  if (response.channel_id !== channelId) throw new Error('AI status channel mismatch.');
  return response;
}
