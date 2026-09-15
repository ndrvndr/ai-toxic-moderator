import { z } from 'zod';

export const youtubeChatResource = z
  .object({
    id: z.string().min(1).max(1024),
    snippet: z
      .object({
        type: z.string().min(1).max(128),
        liveChatId: z.string().min(1).max(1024),
        publishedAt: z.iso.datetime({ offset: true }),
      })
      .catchall(z.json()),
  })
  .catchall(z.json());

export const youtubeIngestionBatch = z.strictObject({
  expected_revision: z.string().regex(/^(0|[1-9][0-9]*)$/),
  request_page_token: z.string().min(1).nullable(),
  next_page_token: z.string().min(1).nullable(),
  polling_interval_ms: z.number().int().min(1).max(2147483647),
  items: z.array(youtubeChatResource),
});
