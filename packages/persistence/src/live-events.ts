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
