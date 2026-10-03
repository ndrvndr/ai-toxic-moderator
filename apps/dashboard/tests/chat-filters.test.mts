import type { MonitoringRun } from '@moderator/contracts';
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

import { ChatFilterControls } from '../features/live/components/chat-filters.js';
import { useLiveChat } from '../features/live/hooks/use-live-chat.js';
import type { ChatFilters } from '../features/live/lib/chat-filters.js';
import { apiRequest } from '../lib/api-client.js';

vi.mock('../lib/api-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client.js')>()),
  apiRequest: vi.fn(),
}));

const run: MonitoringRun = {
  id: '40000000-0000-4000-8000-000000000004',
  channel_id: '20000000-0000-4000-8000-000000000002',
  session_id: '30000000-0000-4000-8000-000000000003',
  youtube_broadcast_id: 'test-broadcast',
  status: 'STOPPED',
  requested_at: '2026-01-01T00:00:00Z',
  started_at: null,
  stop_requested_at: '2026-01-01T00:00:01Z',
  finished_at: '2026-01-01T00:00:01Z',
  last_error_code: null,
};
const accountId = '10000000-0000-4000-8000-000000000001';
let client: QueryClient;

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}

it('sends filters on every page and starts another combination without the old cursor', async () => {
  vi.mocked(apiRequest).mockImplementation(async (path) => {
    const params = new URL(path, 'http://localhost').searchParams;
    return {
      items: [],
      next_cursor:
        params.get('outcome') === 'REVIEW' &&
        params.get('category') === 'SPAM' &&
        !params.has('cursor')
          ? 'review-next'
          : null,
    };
  });

  const hook = renderHook(
    ({ filters }: { filters: ChatFilters }) => useLiveChat(accountId, run, 'connected', filters),
    {
      initialProps: { filters: { outcome: 'REVIEW', category: 'SPAM' } as ChatFilters },
      wrapper,
    },
  );
  await waitFor(() => {
    expect(hook.result.current.isSuccess).toBe(true);
    expect(hook.result.current.isFetching).toBe(false);
    expect(hook.result.current.hasNextPage).toBe(true);
  });

  await act(async () => {
    const nextPage = await hook.result.current.fetchNextPage();
    expect(nextPage.isError).toBe(false);
    expect(nextPage.data?.pageParams).toEqual([undefined, 'review-next']);
  });
  // Query completion and the observer's React render are scheduled separately.
  await waitFor(() => {
    expect(hook.result.current.isFetching).toBe(false);
    expect(hook.result.current.data?.pageParams).toEqual([undefined, 'review-next']);
  });

  const paginated = vi
    .mocked(apiRequest)
    .mock.calls.map(([path]) => new URL(path, 'http://localhost').searchParams)
    .find((params) => params.has('cursor'));
  expect(paginated?.get('outcome')).toBe('REVIEW');
  expect(paginated?.get('category')).toBe('SPAM');

  vi.mocked(apiRequest).mockClear();
  hook.rerender({ filters: { outcome: 'ALLOW' } });
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(hook.result.current.data?.pageParams).toEqual([undefined]);
  expect(apiRequest).toHaveBeenCalled();
  for (const [path] of vi.mocked(apiRequest).mock.calls) {
    const params = new URL(path, 'http://localhost').searchParams;
    expect(params.get('outcome')).toBe('ALLOW');
    expect(params.has('category')).toBe(false);
    expect(params.has('cursor')).toBe(false);
  }

  hook.rerender({ filters: {} });
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  const lastPath = vi.mocked(apiRequest).mock.calls.at(-1)![0];
  const cleared = new URL(lastPath, 'http://localhost').searchParams;
  expect(cleared.has('outcome')).toBe(false);
  expect(cleared.has('category')).toBe(false);
  expect(cleared.has('cursor')).toBe(false);
});

it('does not fetch filtered chat after access is blocked', async () => {
  renderHook(() => useLiveChat(accountId, run, 'forbidden', { outcome: 'REVIEW' }), { wrapper });
  await act(async () => {
    await Promise.resolve();
  });
  expect(apiRequest).not.toHaveBeenCalled();
});

it('preserves the other filter when changing a selection and clears both explicitly', () => {
  const onChange = vi.fn();
  render(
    createElement(ChatFilterControls, {
      filters: { outcome: 'REVIEW', category: 'SPAM' },
      onChange,
    }),
  );
  expect(screen.getByRole('button', { name: 'Review' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: /^Allowed$/ }));
  expect(onChange).toHaveBeenLastCalledWith({ outcome: 'ALLOW', category: 'SPAM' });
  fireEvent.click(screen.getByRole('button', { name: 'All categories' }));
  expect(onChange).toHaveBeenLastCalledWith({ outcome: 'REVIEW', category: undefined });
  fireEvent.click(screen.getByRole('button', { name: 'Clear chat filters' }));
  expect(onChange).toHaveBeenLastCalledWith({});
});
