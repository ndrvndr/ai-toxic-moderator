import { z } from 'zod';

import { apiRequest } from '@/lib/api-client';

const broadcastSchema = z.object({
  youtube_broadcast_id: z.string(),
  youtube_channel_id: z.string(),
  title: z.string(),
  live_chat_available: z.boolean(),
  scheduled_start_time: z.string().nullable(),
});

const broadcastsSchema = z.object({
  items: z.array(broadcastSchema),
  truncated: z.boolean(),
});

export type Broadcast = z.infer<typeof broadcastSchema>;

export async function getBroadcasts(signal?: AbortSignal) {
  return broadcastsSchema.parse(await apiRequest('/v1/youtube/broadcasts', { signal }));
}
