import { z } from 'zod';

import { monitoringStatus, youtubeBroadcastId } from './monitoring';

export const savedSessionsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(1024).optional(),
  q: z.string().trim().max(100).default(''),
  status: monitoringStatus.optional(),
});

export const savedSessionsCursor = z.strictObject({
  account_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true, precision: 6 }),
  session_id: z.uuid(),
  q: z.string().trim().max(100).default(''),
  status: monitoringStatus.optional(),
});

export const savedSession = z.strictObject({
  session_id: z.uuid(),
  channel_id: z.uuid(),
  youtube_broadcast_id: youtubeBroadcastId,
  title: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  latest_status: monitoringStatus.nullable(),
});

export const savedSessionsPage = z.strictObject({
  items: z.array(savedSession),
  next_cursor: z.string().nullable(),
});

export type SavedSession = z.infer<typeof savedSession>;

export const historySessionsQuery = z.strictObject({
  take: z.coerce.number().int().min(1).max(50).default(10),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  q: z.string().trim().max(100).default(''),
  status: monitoringStatus.optional(),
});
export const historySessionsPage = z.strictObject({
  items: z.array(savedSession).max(50),
  page: z.number().int().positive(),
  take: z.number().int().min(1).max(50),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
});
