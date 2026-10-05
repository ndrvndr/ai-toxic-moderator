import { apiRequest } from '@/lib/api-client';
import {
  aiModerationPreferences,
  aiModerationPreferencesUpdate,
  aiModerationSettingsResponse,
  type AiModerationPreferencesUpdate,
} from '@moderator/contracts';

function path(channelId: string) {
  return `/v1/channels/${encodeURIComponent(channelId)}/ai-moderation-settings`;
}

function result(channelId: string, response: unknown) {
  const { settings } = aiModerationSettingsResponse.parse(response);
  if (settings && settings.channel_id.toLowerCase() !== channelId.toLowerCase()) {
    throw new Error('AI settings channel mismatch.');
  }
  return settings;
}

export async function getAiModerationSettings(channelId: string, signal: AbortSignal) {
  return result(channelId, await apiRequest(path(channelId), { signal }));
}

export async function saveAiModerationSettings(
  channelId: string,
  input: AiModerationPreferencesUpdate,
) {
  const update = aiModerationPreferencesUpdate.parse(input);
  const record = result(
    channelId,
    await apiRequest(path(channelId), {
      method: 'POST',
      body: JSON.stringify(update),
    }),
  );
  if (!record || record.revision !== update.expected_revision + 1) {
    throw new Error('Unexpected AI settings save result.');
  }
  const { model, ...preferences } = record.configuration;
  if (
    JSON.stringify(aiModerationPreferences.parse(preferences)) !==
    JSON.stringify(update.configuration)
  ) {
    throw new Error('Unexpected AI settings save result.');
  }
  return record;
}
