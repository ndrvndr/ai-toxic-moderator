import { apiRequest } from '@/lib/api-client';
import {
  unbanHistory,
  unbanRequest,
  unbanResponse,
  uuid,
  type UnbanRequest,
} from '@moderator/contracts';

export type UnbanTarget = { channelId: string; sessionId: string; executionId: string };

function path(target: UnbanTarget) {
  return `/v1/channels/${uuid.parse(target.channelId)}/sessions/${uuid.parse(target.sessionId)}/ban-executions/${uuid.parse(target.executionId)}/unban`;
}

export async function getUnbanHistory(target: UnbanTarget, signal?: AbortSignal) {
  const history = unbanHistory.parse(await apiRequest(path(target), { signal }));
  if (history.items.some((item) => item.execution_id !== target.executionId))
    throw new Error('Removal history does not match the requested ban.');
  return history;
}

export async function requestUnban(target: UnbanTarget, request: UnbanRequest) {
  const result = unbanResponse.parse(
    await apiRequest(path(target), {
      method: 'POST',
      body: JSON.stringify(unbanRequest.parse(request)),
    }),
  );
  if (result.removal.execution_id !== target.executionId)
    throw new Error('Removal result does not match the requested ban.');
  return result;
}
