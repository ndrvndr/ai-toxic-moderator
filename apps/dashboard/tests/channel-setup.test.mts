import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_QUERY_KEY } from '../features/auth/hooks/use-session.js';
import { ChannelSetup } from '../features/moderation-settings/components/channel-setup.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(createElement(QueryClientProvider, { client }, createElement(ChannelSetup)));
  return invalidate;
}
it('loads only on request and refreshes session memberships after channel setup', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ channel_count: 1 }));
  vi.stubGlobal('fetch', fetcher);
  const invalidate = mount();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Load my channel' }));
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: SESSION_QUERY_KEY }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toMatch(/\/v1\/youtube\/channels\/sync$/);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    credentials: 'include',
    body: '{}',
  });
});
it('explains an empty account without asking the streamer to start monitoring', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ channel_count: 0 })));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Load my channel' }));
  await screen.findByText(/No YouTube channel was found/);
  expect(screen.getByRole('link', { name: 'Connect another Google account' })).toBeTruthy();
});
it('shows a safe failure and lets the streamer retry without an automatic request loop', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: { code: 'YOUTUBE_FORBIDDEN' } }, { status: 502 }))
    .mockResolvedValueOnce(Response.json({ channel_count: 1 }));
  vi.stubGlobal('fetch', fetcher);
  const invalidate = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Load my channel' }));
  await screen.findByRole('alert');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(invalidate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Load my channel' }));
  await waitFor(() => expect(invalidate).toHaveBeenCalled());
  expect(fetcher).toHaveBeenCalledTimes(2);
});
