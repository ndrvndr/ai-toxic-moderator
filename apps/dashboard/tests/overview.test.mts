import type { SavedSession } from '@moderator/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useSession } from '../features/auth/hooks/use-session.js';
import {
  getHistoryActionStatistics,
  getHistoryStatistics,
} from '../features/history/api/history-api.js';
import { getSavedSessions } from '../features/live/api/saved-sessions-api.js';
import { OverviewPage } from '../features/overview/components/overview-page.js';

vi.mock('../features/auth/hooks/use-session.js', () => ({
  SESSION_QUERY_KEY: ['auth', 'session'],
  useSession: vi.fn(),
}));
vi.mock('../features/live/api/saved-sessions-api.js', () => ({ getSavedSessions: vi.fn() }));
vi.mock('../features/history/api/history-api.js', () => ({
  getHistoryStatistics: vi.fn(),
  getHistoryActionStatistics: vi.fn(),
}));

const accountId = '10000000-0000-4000-8000-000000000001';
const saved: SavedSession = {
  session_id: '20000000-0000-4000-8000-000000000002',
  channel_id: '30000000-0000-4000-8000-000000000003',
  youtube_broadcast_id: 'test-broadcast',
  title: 'Friday stream',
  created_at: '2026-10-01T10:00:00Z',
  latest_status: 'STOPPED',
};
let client: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(useSession).mockReturnValue({
    data: { account: { id: accountId, display_name: 'Andre' }, memberships: [] },
    isError: false,
    isFetching: false,
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(getSavedSessions).mockResolvedValue({ items: [], next_cursor: null });
  vi.mocked(getHistoryStatistics).mockResolvedValue({
    session_id: saved.session_id,
    total_messages: 12,
    allowed_messages: 9,
    flagged_messages: 3,
    error_messages: 0,
    unevaluated_messages: 0,
    flagged_reasons: [{ category: 'SPAM', reason_code: 'CONTEXT_REQUIRED', message_count: 3 }],
  });
  vi.mocked(getHistoryActionStatistics).mockResolvedValue({
    session_id: saved.session_id,
    delete: { total: 9, dispatched: 2, succeeded: 4, rejected: 1, not_sent: 1, unknown: 1 },
    timeout: { total: 2, dispatched: 0, succeeded: 1, rejected: 0, not_sent: 0, unknown: 1 },
    ban: { total: 1, dispatched: 0, succeeded: 0, rejected: 1, not_sent: 0, unknown: 0 },
  });
});

afterEach(() => {
  cleanup();
  client.clear();
});

function show() {
  return render(createElement(QueryClientProvider, { client }, createElement(OverviewPage)));
}

function withSavedStream() {
  vi.mocked(getSavedSessions).mockImplementation(async (_cursor, _signal, _search, status) => ({
    items: status ? [] : [saved],
    next_cursor: null,
  }));
}

it('shows a useful empty overview without fetching statistics for a missing stream', async () => {
  show();
  await screen.findByText('Your first stream report starts here');
  expect(screen.getByRole('heading', { name: 'Welcome back, Andre.' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Find your livestream' }).getAttribute('href')).toBe(
    '/live',
  );
  expect(getHistoryStatistics).not.toHaveBeenCalled();
  expect(getHistoryActionStatistics).not.toHaveBeenCalled();
  expect(getSavedSessions).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Google connected')).toBeNull();
});

it('finds monitoring streams separately from the latest saved stream', async () => {
  vi.mocked(getSavedSessions).mockImplementation(async (_cursor, _signal, _search, status) => ({
    items:
      status === 'RUNNING'
        ? [{ ...saved, title: 'Older active stream', latest_status: 'RUNNING' }]
        : [saved],
    next_cursor: null,
  }));
  show();
  await screen.findByText('Older active stream');
  expect(screen.getByText('Friday stream')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'View stream report' }).getAttribute('href')).toBe(
    `/history/${saved.session_id}`,
  );
  expect(screen.getByRole('link', { name: 'Review your blocked words' }).getAttribute('href')).toBe(
    '/settings/moderation',
  );
});

it('counts confirmed outcomes rather than planned, pending, or unknown actions', async () => {
  withSavedStream();
  show();
  await waitFor(() =>
    expect(screen.getByText('Actions confirmed').parentElement?.textContent).toContain('5'),
  );
  expect(screen.getByText('Chat messages').parentElement?.textContent).toContain('12');
  expect(screen.getByText('Messages flagged').parentElement?.textContent).toContain('3');
});

it('shows unavailable totals on failure without presenting a false zero', async () => {
  withSavedStream();
  vi.mocked(getHistoryActionStatistics).mockRejectedValue(new Error('private connection details'));
  show();
  await screen.findByText(
    'Some stream totals are unavailable. You can try again or open the full report.',
  );
  const action = screen.getByText('Actions confirmed').parentElement!;
  expect(within(action).getByText('Unavailable')).toBeTruthy();
  expect(screen.queryByText('private connection details')).toBeNull();
});

it('keeps failures distinct from an empty stream list', async () => {
  vi.mocked(getSavedSessions).mockRejectedValue(new Error('access denied'));
  show();
  await screen.findByText('We couldn’t load your saved streams.');
  expect(screen.queryByText('Your first stream report starts here')).toBeNull();
  expect(screen.queryByText('Ready for your next stream?')).toBeNull();
});
