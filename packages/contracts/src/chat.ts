import { z } from 'zod';

export const chatQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

export const chatCursor = z.strictObject({
  version: z.literal(1),
  channel_id: z.uuid(),
  session_id: z.uuid(),
  received_at: z.iso.datetime({ precision: 6 }),
  id: z.uuid(),
});

export const chatObservation = z.strictObject({
  id: z.uuid(),
  external_message_id: z.string().min(1).max(1024),
  event_type: z.string().min(1).max(128),
  published_at: z.iso.datetime(),
  received_at: z.iso.datetime(),
  display_text: z.string().nullable(),
  author_channel_id: z.string().nullable(),
  author_display_name: z.string().nullable(),
  evaluation_status: z.literal('NOT_EVALUATED'),
});

export const chatPage = z.strictObject({
  items: z.array(chatObservation),
  next_cursor: z.string().nullable(),
});

export type ChatObservation = z.infer<typeof chatObservation>;
export type ChatPage = z.infer<typeof chatPage>;
