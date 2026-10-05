import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SessionGuard } from '../features/auth/components/session-guard.js';
import { SESSION_QUERY_KEY } from '../features/auth/hooks/use-session.js';
import { useBroadcasts } from '../features/live/hooks/use-broadcasts.js';
import { ApiError } from '../lib/api-client.js';

const mocks = vi.hoisted(() => ({ session: vi.fn(), replace: vi.fn(), broadcasts: vi.fn() }));
vi.mock('../features/auth/api/auth-api.js', () => ({ getSession: mocks.session }));
vi.mock('../features/live/api/broadcasts-api.js', () => ({ getBroadcasts: mocks.broadcasts }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));

const verified = { account: { id: 'account-1', display_name: 'Andre' }, memberships: [] };
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.session.mockResolvedValue(verified);
  mocks.broadcasts.mockResolvedValue({ items: [], truncated: false });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
function mount() {
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        SessionGuard,
        null,
        createElement('div', { 'data-testid': 'dashboard' }, 'Dashboard content'),
      ),
    ),
  );
}
async function advance(ms = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function fail(error: unknown) {
  mocks.session.mockRejectedValue(error);
  await act(async () => {
    await client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  });
  await advance();
}

it.each([0, 503])(
  'preserves the mounted dashboard after temporary error %s and recovers automatically',
  async (status) => {
    mount();
    await advance();
    const dashboard = screen.getByTestId('dashboard');
    await fail(new ApiError(status, 'NETWORK_ERROR'));
    expect(screen.getByTestId('dashboard')).toBe(dashboard);
    expect(screen.getByText(/Connection interrupted/)).toBeTruthy();
    expect(screen.queryByText('Unable to verify your session')).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue(verified);
    await advance(5000);
    expect(screen.getByTestId('dashboard')).toBe(dashboard);
    expect(screen.queryByText(/Connection interrupted/)).toBeNull();
  },
);

it('does not open a dashboard without a verified session during an outage', async () => {
  mocks.session.mockRejectedValue(new ApiError(0, 'NETWORK_ERROR'));
  mount();
  await advance();
  expect(screen.queryByTestId('dashboard')).toBeNull();
  expect(screen.getByText('Unable to verify your session')).toBeTruthy();
  mocks.session.mockResolvedValue(verified);
  await advance(5000);
  expect(screen.getByTestId('dashboard')).toBeTruthy();
});

it('closes cached access and clears private queries when revalidation returns an expired session', async () => {
  mount();
  await advance();
  client.setQueryData(['live-chat', 'account-1'], { private: true });
  await fail(new ApiError(0, 'NETWORK_ERROR'));
  mocks.session.mockResolvedValue(null);
  await advance(5000);
  expect(screen.queryByTestId('dashboard')).toBeNull();
  expect(mocks.replace).toHaveBeenCalledWith('/login?auth=expired');
  expect(client.getQueryData(['live-chat', 'account-1'])).toBeUndefined();
  const requests = mocks.session.mock.calls.length;
  await advance(15000);
  expect(mocks.session).toHaveBeenCalledTimes(requests);
});

it.each([403, 404])(
  'does not retain dashboard access after non-transient error %s',
  async (status) => {
    mount();
    await advance();
    await fail(new ApiError(status, 'ACCESS_DENIED'));
    expect(screen.queryByTestId('dashboard')).toBeNull();
    expect(screen.getByText('Unable to verify your session')).toBeTruthy();
    const requests = mocks.session.mock.calls.length;
    await advance(15000);
    expect(mocks.session).toHaveBeenCalledTimes(requests);
  },
);

it('stops automatic session recovery when the dashboard is unmounted', async () => {
  const view = mount();
  await advance();
  await fail(new ApiError(0, 'NETWORK_ERROR'));
  view.unmount();
  const requests = mocks.session.mock.calls.length;
  await advance(15000);
  expect(mocks.session).toHaveBeenCalledTimes(requests);
});

it('recovers broadcast listing after a server outage and stops interval requests after success', async () => {
  const view = renderHook(() => useBroadcasts('account-1'), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  });
  await advance(20);
  expect(view.result.current.isSuccess).toBe(true);
  mocks.broadcasts.mockRejectedValue(new ApiError(503, 'UNAVAILABLE'));
  await act(async () => {
    await view.result.current.refetch();
  });
  await advance();
  expect(view.result.current.isError).toBe(true);
  expect(view.result.current.data).toEqual({ items: [], truncated: false });
  mocks.broadcasts.mockResolvedValue({ items: [], truncated: false });
  await advance(5000);
  expect(view.result.current.isSuccess).toBe(true);
  const requests = mocks.broadcasts.mock.calls.length;
  await advance(15000);
  expect(mocks.broadcasts).toHaveBeenCalledTimes(requests);
});
