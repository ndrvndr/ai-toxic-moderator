import { chatPage } from '@moderator/contracts';

import { apiRequest } from '@/lib/api-client';

import type { ChatFilters } from '../lib/chat-filters';

export async function getChatPage({
  channelId,
  sessionId,
  cursor,
  signal,
  filters = {},
}: {
  channelId: string;
  sessionId: string;
  cursor?: string;
  signal?: AbortSignal;
  filters?: ChatFilters;
}) {
  const query = new URLSearchParams({ limit: '50' });

  if (cursor) query.set('cursor', cursor);
  if (filters.outcome) query.set('outcome', filters.outcome);
  if (filters.category) query.set('category', filters.category);

  return chatPage.parse(
    await apiRequest(`/v1/channels/${channelId}/sessions/${sessionId}/chat?${query}`, { signal }),
  );
}
