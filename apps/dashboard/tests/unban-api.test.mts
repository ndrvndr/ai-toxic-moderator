import { afterEach, expect, it, vi } from 'vitest';
import { getUnbanHistory, requestUnban } from '../features/live/api/unban-api.js';

const target = {
  channelId: '10000000-0000-4000-8000-000000000001',
  sessionId: '10000000-0000-4000-8000-000000000002',
  executionId: '10000000-0000-4000-8000-000000000003',
};
const result = {
  id: '10000000-0000-4000-8000-000000000004',
  execution_id: target.executionId,
  method: 'YOUTUBE',
  status: 'SUCCEEDED',
  requested_at: '2026-10-01T00:00:00Z',
  finished_at: '2026-10-01T00:00:01Z',
};
afterEach(() => vi.unstubAllGlobals());

it('sends only the validated owner intent using the scoped ban resource and session cookie', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ removal: result, reused: false })));
  vi.stubGlobal('fetch', fetch);
  const intent = { request_id: '10000000-0000-4000-8000-000000000005', method: 'YOUTUBE' } as const;
  const response = await requestUnban(target, intent);
  expect(response.removal.execution_id).toBe(target.executionId);
  expect(fetch.mock.calls[0]?.[0]).toContain(
    `/v1/channels/${target.channelId}/sessions/${target.sessionId}/ban-executions/${target.executionId}/unban`,
  );
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify(intent),
  });
});

it('rejects history belonging to a different ban instead of showing it on this message', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [{ ...result, execution_id: target.sessionId }] })),
      ),
  );
  await expect(getUnbanHistory(target)).rejects.toThrow(/does not match/);
});

it('rejects a mutation response for another execution', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ removal: { ...result, execution_id: target.sessionId }, reused: false }),
        ),
      ),
  );
  await expect(
    requestUnban(target, { request_id: target.channelId, method: 'YOUTUBE' }),
  ).rejects.toThrow(/does not match/);
});

it('does not request a resource with malformed scope identifiers', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(getUnbanHistory({ ...target, executionId: '../another-ban' })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
