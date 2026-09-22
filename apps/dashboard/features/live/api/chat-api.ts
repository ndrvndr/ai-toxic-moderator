import { chatPage } from '@moderator/contracts';

import { apiRequest } from '@/lib/api-client';

export async function getChatPage({
  channelId,
  sessionId,
  cursor,
  signal,
}: {
  channelId: string;
  sessionId: string;
  cursor?: string;
  signal?: AbortSignal;
}) {
  const query = new URLSearchParams({ limit: '50' });

  if (cursor) query.set('cursor', cursor);

  return chatPage.parse(
    await apiRequest(`/v1/channels/${channelId}/sessions/${sessionId}/chat?${query}`, { signal }),
  );
}
