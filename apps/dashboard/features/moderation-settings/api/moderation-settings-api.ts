import {
  moderationRuleCatalogResponse,
  moderationSettingsResponse,
  moderationSettingsUpdate,
  type ModerationSettingsUpdate,
} from '@moderator/contracts';

import { apiRequest } from '@/lib/api-client';

function settingsPath(channelId: string) {
  return `/v1/channels/${encodeURIComponent(channelId)}/moderation-settings`;
}

function settingsResult(channelId: string, response: unknown) {
  const result = moderationSettingsResponse.parse(response);
  if (result.settings && result.settings.channel_id.toLowerCase() !== channelId.toLowerCase()) {
    throw new Error('Moderation settings channel mismatch.');
  }
  return result.settings;
}

export async function getModerationSettings(channelId: string, signal: AbortSignal) {
  return settingsResult(channelId, await apiRequest(settingsPath(channelId), { signal }));
}

export async function getModerationRuleCatalog(channelId: string, signal: AbortSignal) {
  return moderationRuleCatalogResponse.parse(
    await apiRequest(`${settingsPath(channelId)}/rules`, { signal }),
  ).items;
}

export async function saveModerationSettings(channelId: string, input: ModerationSettingsUpdate) {
  const update = moderationSettingsUpdate.parse(input);
  const result = settingsResult(
    channelId,
    await apiRequest(settingsPath(channelId), {
      method: 'POST',
      body: JSON.stringify(update),
    }),
  );
  if (!result || result.revision !== update.expected_revision + 1) {
    throw new Error('Unexpected moderation settings save result.');
  }
  return result;
}
