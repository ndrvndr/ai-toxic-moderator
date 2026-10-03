import { apiRequest } from '@/lib/api-client';
import {
  customBlacklistResponse,
  customBlacklistUpdate,
  type CustomBlacklistUpdate,
} from '@moderator/contracts';

function path(channelId: string) {
  return `/v1/channels/${encodeURIComponent(channelId)}/blacklist`;
}

function result(channelId: string, response: unknown) {
  const { blacklist } = customBlacklistResponse.parse(response);
  if (blacklist && blacklist.channel_id.toLowerCase() !== channelId.toLowerCase()) {
    throw new Error('Blacklist channel mismatch.');
  }
  return blacklist;
}

export async function getCustomBlacklist(channelId: string, signal: AbortSignal) {
  return result(channelId, await apiRequest(path(channelId), { signal }));
}

export async function saveCustomBlacklist(channelId: string, input: CustomBlacklistUpdate) {
  const update = customBlacklistUpdate.parse(input);
  const record = result(
    channelId,
    await apiRequest(path(channelId), {
      method: 'POST',
      body: JSON.stringify(update),
    }),
  );
  if (!record || record.revision !== update.expected_revision + 1) {
    throw new Error('Unexpected blacklist save result.');
  }
  return record;
}
