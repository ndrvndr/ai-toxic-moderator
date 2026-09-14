import type { PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';

import type { VerifiedBroadcast } from '../auth/google-provider';
import { failure } from '../http';

export type YoutubeSession = Readonly<{
  channel_id: string;
  session_id: string;
}>;

/**
 * Call inside a transaction, using the authenticated account ID and a broadcast
 * returned by GoogleService.verifyBroadcast() for that same account.
 */
export async function resolveYoutubeSession(
  client: PoolClient,
  accountId: string,
  broadcast: VerifiedBroadcast,
): Promise<YoutubeSession> {
  // Always acquire channel and broadcast locks in this order.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `youtube-channel:${broadcast.youtube_channel_id}`,
  ]);

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `youtube-broadcast:${broadcast.youtube_broadcast_id}`,
  ]);

  const channelResult = await client.query<{ channel_id: string }>(
    `
      SELECT channel_id
      FROM youtube_channels
      WHERE youtube_channel_id = $1
    `,
    [broadcast.youtube_channel_id],
  );

  let channelId = channelResult.rows[0]?.channel_id;

  if (!channelId) {
    channelId = randomUUID();

    await client.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
      channelId,
      broadcast.channel_title,
    ]);

    await client.query(
      `
        INSERT INTO youtube_channels(channel_id, youtube_channel_id)
        VALUES($1, $2)
      `,
      [channelId, broadcast.youtube_channel_id],
    );
  }

  const broadcastResult = await client.query<{
    channel_id: string;
    session_id: string;
    live_chat_id: string;
  }>(
    `
      SELECT channel_id, session_id, live_chat_id
      FROM youtube_broadcasts
      WHERE youtube_broadcast_id = $1
    `,
    [broadcast.youtube_broadcast_id],
  );

  const existing = broadcastResult.rows[0];

  if (
    existing &&
    (existing.channel_id !== channelId || existing.live_chat_id !== broadcast.live_chat_id)
  ) {
    throw failure(
      409,
      'BROADCAST_MAPPING_CONFLICT',
      'The verified broadcast does not match its stored channel or live chat.',
    );
  }

  // Ownership was verified through Google for this account before this transaction.
  await client.query(
    `
      INSERT INTO channel_memberships(channel_id, account_id, role)
      VALUES($1, $2, 'OWNER')
      ON CONFLICT(channel_id, account_id)
      DO UPDATE SET role = 'OWNER'
      WHERE channel_memberships.role <> 'OWNER'
    `,
    [channelId, accountId],
  );

  if (existing) {
    return Object.freeze({
      channel_id: channelId,
      session_id: existing.session_id,
    });
  }

  const sessionId = randomUUID();

  await client.query(
    `
      INSERT INTO stream_sessions(id, channel_id, label, source)
      VALUES($1, $2, $3, 'YOUTUBE')
    `,
    [sessionId, channelId, broadcast.title],
  );

  await client.query(
    `
      INSERT INTO youtube_broadcasts(
        session_id,
        channel_id,
        youtube_broadcast_id,
        live_chat_id
      )
      VALUES($1, $2, $3, $4)
    `,
    [sessionId, channelId, broadcast.youtube_broadcast_id, broadcast.live_chat_id],
  );

  return Object.freeze({
    channel_id: channelId,
    session_id: sessionId,
  });
}
