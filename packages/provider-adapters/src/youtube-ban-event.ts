import { z } from 'zod';

const identifier = z.string().min(1).max(1024).regex(/^\S+$/u);

const duration = z
  .union([z.number().int().positive().safe(), z.string().regex(/^[1-9][0-9]*$/)])
  .transform((value) => String(value))
  .refine(
    (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
    'Duration exceeds the supported range.',
  );

const bannedUser = z.object({
  channelId: identifier,
});

const banDetails = z.discriminatedUnion('banType', [
  z.object({
    banType: z.literal('temporary'),
    banDurationSeconds: duration,
    bannedUserDetails: bannedUser,
  }),
  z.object({
    banType: z.literal('permanent'),
    bannedUserDetails: bannedUser,
    banDurationSeconds: z.never().optional(),
  }),
]);

const eventSchema = z.object({
  id: identifier,
  snippet: z.object({
    type: z.literal('userBannedEvent'),
    liveChatId: identifier,
    authorChannelId: identifier,
    publishedAt: z.iso.datetime({ offset: true }),
    userBannedDetails: banDetails,
  }),
});

export type YoutubeBanEventEvidence = {
  externalEventId: string;
  liveChatId: string;
  moderatorChannelId: string;
  targetChannelId: string;
  publishedAt: string;
} & ({ action: 'TIMEOUT'; durationSeconds: string } | { action: 'BAN'; durationSeconds: null });

/**
 * Extract provider evidence without attributing it to an application attempt.
 * Missing or unsupported evidence must not authorize retries or state changes.
 */
export function parseYoutubeBanEvent(value: unknown): YoutubeBanEventEvidence | null {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) return null;

  const { id, snippet } = parsed.data;
  const details = snippet.userBannedDetails;

  const common = {
    externalEventId: id,
    liveChatId: snippet.liveChatId,
    moderatorChannelId: snippet.authorChannelId,
    targetChannelId: details.bannedUserDetails.channelId,
    publishedAt: snippet.publishedAt,
  };

  return details.banType === 'temporary'
    ? {
        ...common,
        action: 'TIMEOUT',
        durationSeconds: details.banDurationSeconds,
      }
    : {
        ...common,
        action: 'BAN',
        durationSeconds: null,
      };
}
