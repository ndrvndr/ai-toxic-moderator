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
  offline_at: z.iso.datetime({ offset: true }).nullable().default(null),
  items: z.array(youtubeChatResource),
});

export const youtubeChatListResponse = z
  .object({
    nextPageToken: z.string().min(1).optional(),
    pollingIntervalMillis: z.number().int().min(0).max(2147483647),
    offlineAt: z.iso.datetime({ offset: true }).optional(),
    items: z.array(youtubeChatResource),
    activePollItem: youtubeChatResource.optional(),
  })
  .superRefine((response, context) => {
    if (!response.nextPageToken && !response.offlineAt) {
      context.addIssue({
        code: 'custom',
        path: ['nextPageToken'],
        message: 'An active chat response must provide a continuation token.',
      });
    }
  });
