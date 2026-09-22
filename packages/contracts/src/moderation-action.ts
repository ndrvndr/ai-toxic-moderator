import { z } from 'zod';

const actionContext = {
  classification_id: z.uuid(),
  channel_id: z.uuid(),
  session_id: z.uuid(),
  policy_version: z.string().min(1).max(128),
  reason: z.string().min(1).max(2000),
};

const externalId = z.string().min(1).max(1024);

export const moderationActionPlan = z.discriminatedUnion('action', [
  z.strictObject({
    ...actionContext,
    action: z.literal('NONE'),
  }),
  z.strictObject({
    ...actionContext,
    action: z.literal('DELETE'),
    external_message_id: externalId,
  }),
  z.strictObject({
    ...actionContext,
    action: z.literal('TIMEOUT'),
    author_channel_id: externalId,
    duration_seconds: z.number().int().positive().safe(),
  }),
  z.strictObject({
    ...actionContext,
    action: z.literal('BAN'),
    author_channel_id: externalId,
  }),
]);

export type ModerationActionPlan = z.infer<typeof moderationActionPlan>;
