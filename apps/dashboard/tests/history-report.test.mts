import type { HistoryActionStatistics, SavedSession } from '@moderator/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { HistoryActionStatisticsPanel } from '../features/history/components/history-action-statistics-panel.js';
import { HistorySessionCard } from '../features/history/components/history-session-card.js';
import { ApiError } from '../lib/api-client.js';

const mocks = vi.hoisted(() => ({ actions: vi.fn(), refetch: vi.fn() }));
vi.mock('../features/history/hooks/use-history-action-statistics.js', () => ({
  useHistoryActionStatistics: mocks.actions,
}));
const session: SavedSession = {
  session_id: '10000000-0000-4000-8000-000000000001',
  channel_id: '20000000-0000-4000-8000-000000000002',
  title: 'Friday stream',
  youtube_broadcast_id: 'fixture-broadcast',
  created_at: '2026-10-05T00:00:00Z',
  latest_status: 'STOPPED',
};
const data: HistoryActionStatistics = {
  session_id: session.session_id,
  delete: { total: 9, succeeded: 3, dispatched: 2, rejected: 1, not_sent: 1, unknown: 2 },
  timeout: { total: 4, succeeded: 2, dispatched: 0, rejected: 0, not_sent: 1, unknown: 1 },
  ban: { total: 1, succeeded: 0, dispatched: 0, rejected: 1, not_sent: 0, unknown: 0 },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actions.mockReturnValue({
    data,
    isPending: false,
    isError: false,
    isFetching: false,
    dataUpdatedAt: Date.parse('2026-10-05T00:00:01Z'),
    refetch: mocks.refetch,
  });
});
afterEach(cleanup);
function show() {
  return render(
    createElement(HistoryActionStatisticsPanel, {
      accountId: 'fixture-account',
      sessionId: session.session_id,
    }),
  );
}

it('highlights only confirmed actions and keeps uncertain and awaiting results visible', () => {
  const view = show();
  const panel = within(screen.getByRole('region', { name: 'Moderation action results' }));
  expect(panel.getByText('Messages deleted').parentElement?.querySelector('dd')?.textContent).toBe(
    '3',
  );
  expect(
    panel.getByText('Timeouts confirmed').parentElement?.querySelector('dd')?.textContent,
  ).toBe('2');
  expect(panel.getByText('Bans confirmed').parentElement?.querySelector('dd')?.textContent).toBe(
    '0',
  );
  expect(panel.getByText(/3 requests have an uncertain result/)).toBeTruthy();
  expect(panel.getByText('2 requests are still awaiting a result.')).toBeTruthy();
  expect(panel.getByText(/not unique viewers/)).toBeTruthy();
  expect(view.container.querySelector('details')?.open).toBe(false);
  fireEvent.click(panel.getAllByText('All outcomes')[0]!);
  expect(view.container.querySelector('details')?.open).toBe(true);
});

it('updates totals and removes the uncertainty warning when a fresh report has no uncertain requests', () => {
  const view = show();
  mocks.actions.mockReturnValue({
    data: {
      ...data,
      delete: { ...data.delete, succeeded: 5, unknown: 0 },
      timeout: { ...data.timeout, succeeded: 3, unknown: 0 },
    },
    isPending: false,
    isError: false,
    dataUpdatedAt: Date.now(),
  });
  view.rerender(
    createElement(HistoryActionStatisticsPanel, {
      accountId: 'fixture-account',
      sessionId: session.session_id,
    }),
  );
  expect(screen.queryByText(/uncertain result/)).toBeNull();
  expect(screen.getByText('Messages deleted').parentElement?.querySelector('dd')?.textContent).toBe(
    '5',
  );
});

it('hides cached confirmed counts when access to the report is denied', () => {
  mocks.actions.mockReturnValue({ data, isError: true, error: new ApiError(403, 'ACCESS_DENIED') });
  show();
  expect(screen.getByRole('alert').textContent).toContain('Action results are unavailable');
  expect(screen.queryByText('Messages deleted')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

it('allows retrying a temporary report failure without changing stream state', () => {
  mocks.actions.mockReturnValue({
    data,
    isError: true,
    error: new ApiError(0, 'NETWORK_ERROR'),
    refetch: mocks.refetch,
  });
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(mocks.refetch).toHaveBeenCalledTimes(1);
});

it('links a saved stream to its report without claiming that the YouTube stream ended', () => {
  render(createElement(HistorySessionCard, { session }));
  expect(screen.getByRole('link', { name: 'View report' }).getAttribute('href')).toBe(
    `/history/${session.session_id}`,
  );
  expect(screen.getByText('Monitoring ended')).toBeTruthy();
  expect(screen.queryByText('Livestream ended')).toBeNull();
});
