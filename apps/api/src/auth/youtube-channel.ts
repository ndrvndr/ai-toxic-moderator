import type { PoolClient } from '@moderator/persistence';
import type { VerifiedYoutubeChannel } from '@moderator/provider-adapters';
import { randomUUID } from 'node:crypto';

/** Only accept a channel verified with the authenticated account's Google token. */
export async function resolveYoutubeChannel(
  client: PoolClient,
  accountId: string,
  channel: VerifiedYoutubeChannel,
): Promise<string> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `youtube-channel:${channel.youtube_channel_id}`,
  ]);
  const result = await client.query<{ channel_id: string }>(
    'SELECT channel_id FROM youtube_channels WHERE youtube_channel_id = $1',
    [channel.youtube_channel_id],
  );
  const channelId = result.rows[0]?.channel_id ?? randomUUID();
  if (!result.rows.length) {
    await client.query('INSERT INTO channels(id, display_name) VALUES($1, $2)', [
      channelId,
      channel.channel_title,
    ]);
    await client.query(
      'INSERT INTO youtube_channels(channel_id, youtube_channel_id) VALUES($1, $2)',
      [channelId, channel.youtube_channel_id],
    );
  } else {
    await client.query('UPDATE channels SET display_name=$2 WHERE id=$1', [
      channelId,
      channel.channel_title,
    ]);
  }
  await client.query(
    `
    INSERT INTO channel_memberships(channel_id, account_id, role)
    VALUES($1, $2, 'OWNER')
    ON CONFLICT(channel_id, account_id) DO UPDATE SET role = 'OWNER'
    WHERE channel_memberships.role <> 'OWNER'
  `,
    [channelId, accountId],
  );
  return channelId;
}
