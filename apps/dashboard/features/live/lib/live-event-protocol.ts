import { z } from 'zod';

const sequence = z
  .string()
  .refine(
    (value) =>
      value.length <= 19 &&
      /^(0|[1-9][0-9]*)$/.test(value) &&
      BigInt(value) <= 9223372036854775807n,
    'Invalid event sequence.',
  );

const scope = {
  channel_id: z.uuid(),
  session_id: z.uuid(),
};

const frameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ready'),
    ...scope,
    cursor: sequence,
  }),
  z.strictObject({
    type: z.literal('events'),
    ...scope,
    cursor: sequence,
    items: z
      .array(
        z.strictObject({
          sequence,
          run_id: z.uuid(),
          event_type: z.enum(['chat.updated', 'monitoring.updated']),
        }),
      )
      .min(1)
      .max(100),
  }),
]);

export type LivePosition = {
  cursor: string | null;
  ready: boolean;
};

export function consumeLiveFrame(
  raw: unknown,
  expected: { channelId: string; sessionId: string },
  position: LivePosition,
) {
  if (typeof raw !== 'string' || raw.length > 64 * 1024) {
    throw new Error('Invalid live frame.');
  }

  const frame = frameSchema.parse(JSON.parse(raw));

  if (frame.channel_id !== expected.channelId || frame.session_id !== expected.sessionId) {
    throw new Error('Live frame scope mismatch.');
  }

  if (frame.type === 'ready') {
    if (position.ready || (position.cursor !== null && frame.cursor !== position.cursor)) {
      throw new Error('Unexpected live cursor.');
    }

    return {
      cursor: frame.cursor,
      ready: true,
      refreshChat: true,
      refreshMonitoring: true,
    };
  }

  if (!position.ready || position.cursor === null) {
    throw new Error('Live connection is not ready.');
  }

  let cursor = BigInt(position.cursor);
  let previous: bigint | null = null;
  let refreshChat = false;
  let refreshMonitoring = false;

  for (const item of frame.items) {
    const current = BigInt(item.sequence);

    if (previous !== null && current <= previous) {
      throw new Error('Live events are not ordered.');
    }

    previous = current;

    // Replayed events already processed by this connection can be ignored.
    if (current <= cursor) continue;

    if (current !== cursor + 1n) {
      throw new Error('Live event sequence contains a gap.');
    }

    cursor = current;
    refreshChat ||= item.event_type === 'chat.updated';
    refreshMonitoring ||= item.event_type === 'monitoring.updated';
  }

  if (frame.cursor !== frame.items.at(-1)!.sequence) {
    throw new Error('Live frame cursor mismatch.');
  }

  return {
    cursor: cursor.toString(),
    ready: true,
    refreshChat,
    refreshMonitoring,
  };
}
