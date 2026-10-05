import {
  aiOperationalStatusResponse,
  type AiOperationalStatusResponse,
} from '@moderator/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getAiOperationalStatus } from '../features/live/api/ai-operational-status-api.js';
import { AiOperationalStatusPanel } from '../features/live/components/ai-operational-status-panel.js';
import { LivePage } from '../features/live/components/live-page.js';
import { useAiOperationalStatus } from '../features/live/hooks/use-ai-operational-status.js';
import { ApiError } from '../lib/api-client.js';

const mocks = vi.hoisted(() => ({ request: vi.fn(), session: vi.fn(), broadcasts: vi.fn() }));
vi.mock('../lib/api-client.js', async (original) => ({
  ...(await original<typeof import('../lib/api-client.js')>()),
  apiRequest: mocks.request,
}));
vi.mock('../features/auth/hooks/use-session.js', async (original) => ({
  ...(await original<typeof import('../features/auth/hooks/use-session.js')>()),
  useSession: mocks.session,
}));
vi.mock('../features/live/hooks/use-broadcasts.js', () => ({ useBroadcasts: mocks.broadcasts }));
vi.mock('../features/live/components/saved-sessions.js', () => ({ SavedSessions: () => null }));

const accountId = '10000000-0000-4000-8000-000000000001';
const channelId = '20000000-0000-4000-8000-000000000002';
const otherChannel = '20000000-0000-4000-8000-000000000005';
const runId = '40000000-0000-4000-8000-000000000004';
const sessionId = '30000000-0000-4000-8000-000000000003';
const key = ['ai-operational-status', accountId, channelId] as const;
let client: QueryClient;

function response(status = 'ACTIVE', reason = 'RUN_SELECTED', availability = 'ONLINE') {
  return aiOperationalStatusResponse.parse({
    channel_id: channelId,
    availability,
    checked_at: '2026-10-04T00:00:10.000Z',
    stale_after_ms: 30_000,
    report:
      availability === 'UNKNOWN'
        ? null
        : {
            channel_id: channelId,
            session_id:
              ['ACTIVE', 'MODEL_MISMATCH', 'ERROR'].includes(status) || reason === 'RUN_AI_DISABLED'
                ? sessionId
                : null,
            run_id:
              ['ACTIVE', 'MODEL_MISMATCH', 'ERROR'].includes(status) || reason === 'RUN_AI_DISABLED'
                ? runId
                : null,
            status,
            reason,
            error_code: status === 'ERROR' ? 'INFERENCE_TIMEOUT' : null,
            updated_at:
              availability === 'STALE' ? '2026-10-03T23:59:30.000Z' : '2026-10-04T00:00:00.000Z',
            heartbeat_at:
              availability === 'STALE' ? '2026-10-03T23:59:30.000Z' : '2026-10-04T00:00:00.000Z',
          },
  });
}
function Wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}
function panel() {
  return render(createElement(AiOperationalStatusPanel, { accountId, channelId }), {
    wrapper: Wrapper,
  });
}
async function flush(milliseconds = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  mocks.request.mockResolvedValue(response());
  mocks.session.mockReturnValue({
    data: {
      account: { id: accountId },
      memberships: [{ channel_id: channelId, channel_name: 'Andre Live', role: 'OWNER' }],
    },
  });
  mocks.broadcasts.mockReturnValue({
    isSuccess: true,
    data: { items: [], truncated: false },
    refetch: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

it.each([
  ['ACTIVE', 'RUN_SELECTED', 'ONLINE', 'AI processing active'],
  ['WAITING', 'NO_ELIGIBLE_RUN', 'ONLINE', 'AI waiting for a stream'],
  ['DISABLED', 'WORKER_AI_DISABLED', 'ONLINE', 'Automatic AI disabled'],
  ['DISABLED', 'RUN_AI_DISABLED', 'ONLINE', 'AI off for this session'],
  ['MODEL_MISMATCH', 'CAPTURED_MODEL_MISMATCH', 'ONLINE', 'AI setup needs attention'],
  ['CAPACITY_EXCEEDED', 'MULTIPLE_ELIGIBLE_RUNS', 'ONLINE', 'Too many streams for AI'],
  ['ERROR', 'PROCESSING_FAILED', 'ONLINE', 'AI needs attention'],
  ['ACTIVE', 'RUN_SELECTED', 'STALE', 'AI status out of date'],
  ['ACTIVE', 'RUN_SELECTED', 'UNKNOWN', 'AI status unknown'],
])('renders %s / %s / %s as %s', async (status, reason, availability, label) => {
  mocks.request.mockResolvedValue(response(status, reason, availability));
  panel();
  expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
  if (availability !== 'ONLINE') expect(screen.queryByText('AI processing active')).toBeNull();
  if (status === 'ACTIVE' && availability === 'ONLINE')
    expect(screen.getByText(/confirmed by YouTube/)).toBeTruthy();
});

it('shows loading and updates status without reloading the page', async () => {
  let resolve!: (value: AiOperationalStatusResponse) => void;
  mocks.request.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  panel();
  expect(screen.getByText('Checking AI status…')).toBeTruthy();
  await act(async () => {
    resolve(response());
  });
  await screen.findByText('AI processing active');
  act(() => {
    client.setQueryData(key, response('ACTIVE', 'RUN_SELECTED', 'STALE'));
  });
  await screen.findByText('AI status out of date');
  expect(screen.queryByText('AI processing active')).toBeNull();
});

it('keeps expanded details and the current status visible during a background poll', async () => {
  vi.useFakeTimers();
  panel();
  await flush();
  const details = screen.getByText('Status details').closest('details')!;
  act(() => {
    details.open = true;
    fireEvent(details, new Event('toggle'));
  });
  let resolve!: (value: AiOperationalStatusResponse) => void;
  mocks.request.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await flush(5_000);
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(screen.getByText('AI processing active')).toBeTruthy();
  expect(screen.queryByText('Checking AI status…')).toBeNull();
  expect(screen.getByText('Status details').closest('details')).toBe(details);
  expect(details.open).toBe(true);
  await act(async () => {
    resolve(response('WAITING', 'NO_ELIGIBLE_RUN'));
  });
  await flush();
  expect(screen.getByText('AI waiting for a stream')).toBeTruthy();
  expect(screen.getByText('Status details').closest('details')).toBe(details);
  expect(details.open).toBe(true);
});

it('shows the channel name and a stream link without displaying internal identifiers', async () => {
  render(createElement(LivePage), { wrapper: Wrapper });
  await screen.findByText('AI processing active');
  expect(screen.getByText('Andre Live')).toBeTruthy();
  expect(screen.queryByText(channelId, { exact: false })).toBeNull();
  expect(screen.queryByText(runId, { exact: false })).toBeNull();
  expect(screen.getByRole('link', { name: 'View stream in History' }).getAttribute('href')).toBe(
    `/history/${sessionId}`,
  );
});

it('explains problems in closed status details and links to moderation settings', async () => {
  mocks.request.mockResolvedValue(response('ERROR', 'PROCESSING_FAILED'));
  panel();
  await screen.findByText('AI needs attention');
  expect(screen.getByText('AI took too long to check a message.').closest('details')?.open).toBe(
    false,
  );
  expect(screen.getByText(/New AI results may be unavailable/)).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Review moderation settings' }).getAttribute('href'),
  ).toBe('/settings/moderation');
  expect(screen.queryByText('AI processing active')).toBeNull();
});

it('hides cached ACTIVE after a request failure and allows a manual retry', async () => {
  panel();
  await screen.findByText('AI processing active');
  mocks.request.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR'));
  await act(async () => {
    await client.invalidateQueries({ queryKey: key });
  });
  await screen.findByText('AI status unavailable');
  expect(screen.queryByText('AI processing active')).toBeNull();
  expect(screen.queryByText('Status details')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry AI status' }));
  await screen.findByText('AI processing active');
});

it.each(['empty', 'failed'])(
  'Live shows channel AI status when broadcast listing is %s',
  async (listing) => {
    if (listing === 'failed')
      mocks.broadcasts.mockReturnValue({
        isError: true,
        error: new ApiError(503, 'GOOGLE_UNAVAILABLE'),
        refetch: vi.fn(),
      });
    render(createElement(LivePage), { wrapper: Wrapper });
    await screen.findByText('AI processing active');
    expect(mocks.request).toHaveBeenCalledWith(
      `/v1/channels/${channelId}/ai/status`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  },
);

it('Live does not request AI status for an operator membership', async () => {
  mocks.session.mockReturnValue({
    data: {
      account: { id: accountId },
      memberships: [{ channel_id: channelId, role: 'OPERATOR' }],
    },
  });
  render(createElement(LivePage), { wrapper: Wrapper });
  expect(screen.queryByRole('region', { name: 'Automatic AI status' })).toBeNull();
  expect(mocks.request).not.toHaveBeenCalled();
});

it('keeps the saved broadcast list mounted during a temporary listing failure', async () => {
  const view = render(createElement(LivePage), { wrapper: Wrapper });
  await screen.findByText('AI processing active');
  const emptyList = screen.getByText('No active broadcasts');
  mocks.broadcasts.mockReturnValue({
    isError: true,
    data: { items: [], truncated: false },
    error: new ApiError(0, 'NETWORK_ERROR'),
    refetch: vi.fn(),
  });
  view.rerender(createElement(LivePage));
  expect(screen.getByText('No active broadcasts')).toBe(emptyList);
  expect(screen.getByText(/server could not be reached/)).toBeTruthy();
});

it('validates response scope and passes cancellation to the API', async () => {
  const abort = new AbortController();
  await getAiOperationalStatus(channelId, abort.signal);
  expect(mocks.request).toHaveBeenCalledWith(`/v1/channels/${channelId}/ai/status`, {
    signal: abort.signal,
  });
  mocks.request.mockResolvedValue({
    ...response(),
    channel_id: otherChannel,
    report: { ...response().report, channel_id: otherChannel },
  });
  await expect(getAiOperationalStatus(channelId)).rejects.toThrow('AI status channel mismatch');
});

it('polls independently every five seconds and stops polling after unmount', async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useAiOperationalStatus(accountId, channelId), { wrapper: Wrapper });
  await flush();
  expect(hook.result.current.data?.availability).toBe('ONLINE');
  await flush(5_000);
  expect(mocks.request).toHaveBeenCalledTimes(2);
  hook.unmount();
  await flush(20_000);
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 404])(
  'clears cached reports and stops polling after access error %s',
  async (status) => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const hook = renderHook(() => useAiOperationalStatus(accountId, channelId), {
      wrapper: Wrapper,
    });
    await flush();
    mocks.request.mockRejectedValue(new ApiError(status, 'ACCESS_DENIED'));
    await flush(5_000);
    expect(hook.result.current.isError).toBe(true);
    expect(client.getQueryData(key)).toBeNull();
    await flush(20_000);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    if (status === 401) expect(invalidate).toHaveBeenCalledWith({ queryKey: ['auth', 'session'] });
  },
);

it('separates channel and account caches and aborts an in-flight request on unmount', async () => {
  mocks.request.mockImplementation(
    (_path, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Aborted')));
      }),
  );
  const hook = renderHook(() => useAiOperationalStatus(accountId, channelId), { wrapper: Wrapper });
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
  const signal = mocks.request.mock.calls[0]![1].signal as AbortSignal;
  hook.unmount();
  expect(signal.aborted).toBe(true);
  client.setQueryData(key, response());
  expect(
    client.getQueryData(['ai-operational-status', 'another-account', channelId]),
  ).toBeUndefined();
  expect(client.getQueryData(['ai-operational-status', accountId, otherChannel])).toBeUndefined();
});
