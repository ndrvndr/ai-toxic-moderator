import type { PoolClient } from 'pg';

export type LiveEventType = 'chat.updated' | 'monitoring.updated';

type AppendLiveEventInput = {
  channelId: string;
  sessionId: string;
  runId: string;
  type: LiveEventType;
};

/**
 * Call inside the transaction that changes the underlying resource.
 * Append events after acquiring the resource locks required by that transaction.
 */
export async function appendLiveEvent(
  client: PoolClient,
  input: AppendLiveEventInput,
): Promise<{ sequence: string }> {
  await client.query(
    `
      INSERT INTO live_event_counters(channel_id, session_id)
      VALUES($1, $2)
      ON CONFLICT(channel_id, session_id) DO NOTHING
    `,
    [input.channelId, input.sessionId],
  );

  const counter = await client.query<{ sequence: string }>(
    `
      UPDATE live_event_counters
      SET last_sequence = last_sequence + 1
      WHERE channel_id = $1 AND session_id = $2
      RETURNING last_sequence::text AS sequence
    `,
    [input.channelId, input.sessionId],
  );

  const sequence = counter.rows[0]!.sequence;

  await client.query(
    `
      INSERT INTO live_events(
        channel_id,
        session_id,
        sequence,
        run_id,
        event_type
      )
      VALUES($1, $2, $3::bigint, $4, $5)
    `,
    [input.channelId, input.sessionId, sequence, input.runId, input.type],
  );

  return { sequence };
}

export type StoredLiveEvent = {
  sequence: string;
  run_id: string;
  event_type: LiveEventType;
};

export type LiveEventPage = {
  watermark: string;
  next_cursor: string;
  has_more: boolean;
  items: StoredLiveEvent[];
};

export class InvalidLiveEventCursorError extends Error {
  constructor() {
    super('Invalid live event cursor.');
    this.name = 'InvalidLiveEventCursorError';
  }
}

export class LiveEventSessionNotFoundError extends Error {
  constructor() {
    super('Live event session was not found.');
    this.name = 'LiveEventSessionNotFoundError';
  }
}

type ReadLiveEventsInput = {
  channelId: string;
  sessionId: string;
  after: string | null;
  limit?: number;
};

type LiveEventRow = {
  watermark: string;
  sequence: string | null;
  run_id: string | null;
  event_type: LiveEventType | null;
};

const MAX_SEQUENCE = 9223372036854775807n;

function validateLiveEventCursor(value: string): void {
  if (value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MAX_SEQUENCE) {
    throw new InvalidLiveEventCursorError();
  }
}

/**
 * Reads committed events using one database snapshot.
 * The caller must authenticate the session and authorize channel access.
 * A null cursor starts at the current watermark without replaying older events.
 */
export async function readLiveEvents(
  client: PoolClient,
  input: ReadLiveEventsInput,
): Promise<LiveEventPage> {
  const limit = input.limit ?? 100;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Live event limit must be between 1 and 100.');
  }

  if (input.after !== null) {
    validateLiveEventCursor(input.after);
  }

  const result = await client.query<LiveEventRow>(
    `
      WITH feed AS (
        SELECT
          b.channel_id,
          b.session_id,
          COALESCE(c.last_sequence, 0::bigint) AS watermark
        FROM youtube_broadcasts b
        LEFT JOIN live_event_counters c
          ON c.channel_id = b.channel_id
          AND c.session_id = b.session_id
        WHERE b.channel_id = $1
          AND b.session_id = $2
      )
      SELECT
        feed.watermark::text AS watermark,
        event.sequence::text AS sequence,
        event.run_id,
        event.event_type
      FROM feed
      LEFT JOIN LATERAL (
        SELECT sequence, run_id, event_type
        FROM live_events
        WHERE channel_id = feed.channel_id
          AND session_id = feed.session_id
          AND sequence > COALESCE($3::bigint, feed.watermark)
          AND sequence <= feed.watermark
        ORDER BY sequence ASC
        LIMIT $4
      ) event ON true
      ORDER BY event.sequence ASC
    `,
    [input.channelId, input.sessionId, input.after, limit + 1],
  );

  const first = result.rows[0];

  if (!first) {
    throw new LiveEventSessionNotFoundError();
  }

  const cursor = input.after ?? first.watermark;

  if (BigInt(cursor) > BigInt(first.watermark)) {
    throw new InvalidLiveEventCursorError();
  }

  const events: StoredLiveEvent[] = [];

  for (const row of result.rows) {
    if (row.sequence !== null && row.run_id !== null && row.event_type !== null) {
      events.push({
        sequence: row.sequence,
        run_id: row.run_id,
        event_type: row.event_type,
      });
    }
  }

  const items = events.slice(0, limit);

  return {
    watermark: first.watermark,
    next_cursor: items.at(-1)?.sequence ?? cursor,
    has_more: events.length > limit,
    items,
  };
}
