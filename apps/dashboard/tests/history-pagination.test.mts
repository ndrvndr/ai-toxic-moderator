import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistorySearchForm } from '../features/history/components/history-search-form.js';
import { HistorySessionList } from '../features/history/components/history-session-list.js';
const mocks = vi.hoisted(() => ({ history: vi.fn(), push: vi.fn() }));
vi.mock('../features/history/hooks/use-history-page.js', () => ({ useHistoryPage: mocks.history }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.history.mockReturnValue({
    data: { items: [], total: 22, total_pages: 3, page: 1, take: 10 },
    isPending: false,
    isError: false,
    isFetching: false,
  });
});
afterEach(cleanup);
it('starts at page one with ten items and retains filters when navigating', () => {
  render(
    createElement(HistorySessionList, {
      accountId: 'account',
      search: 'Friday',
      status: 'STOPPED',
    }),
  );
  expect(mocks.history).toHaveBeenCalledWith('account', 'Friday', 'STOPPED', 1, 10);
  expect(screen.getByText(/Page 1 of 3/)).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Go to next page' }));
  expect(mocks.push).toHaveBeenCalledWith('/history?page=2&take=10&q=Friday&status=STOPPED');
  expect(screen.getByText('Previous').closest('a')?.getAttribute('aria-disabled')).toBe('true');
});
it('applying filters resets the page and retains the page size', () => {
  render(createElement(HistorySearchForm, { search: 'old', status: '', take: 20 }));
  fireEvent.change(screen.getByLabelText('Livestream title'), { target: { value: 'new' } });
  fireEvent.click(screen.getByRole('button', { name: 'Stopped' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
  expect(mocks.push).toHaveBeenCalledWith('/history?page=1&take=20&q=new&status=STOPPED');
});
