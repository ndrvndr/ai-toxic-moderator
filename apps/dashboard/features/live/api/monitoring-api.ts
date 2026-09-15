import {
  monitoringStatusResponse,
  startMonitoringResponse,
  stopMonitoringResponse,
} from '@moderator/contracts';

import { apiRequest } from '@/lib/api-client';

export async function getLatestMonitoring(broadcastId: string, signal?: AbortSignal) {
  return monitoringStatusResponse.parse(
    await apiRequest(`/v1/youtube/broadcasts/${encodeURIComponent(broadcastId)}/monitoring`, {
      signal,
    }),
  );
}

export async function startMonitoring(broadcastId: string, requestKey: string) {
  return startMonitoringResponse.parse(
    await apiRequest('/v1/monitoring/start', {
      method: 'POST',
      headers: { 'Idempotency-Key': requestKey },
      body: JSON.stringify({ youtube_broadcast_id: broadcastId }),
    }),
  );
}

export async function stopMonitoring(channelId: string, runId: string) {
  return stopMonitoringResponse.parse(
    await apiRequest(`/v1/channels/${channelId}/monitoring/${runId}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  );
}
