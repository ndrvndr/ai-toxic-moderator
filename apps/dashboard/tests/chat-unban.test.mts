import { chatAuthorAction, type UnbanSummary } from '@moderator/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getUnbanHistory, requestUnban } from '../features/live/api/unban-api.js';
import { ChatUnban } from '../features/live/components/chat-unban.js';
import { ApiError } from '../lib/api-client.js';

vi.mock('../features/live/api/unban-api.js', () => ({
  getUnbanHistory: vi.fn(),
  requestUnban: vi.fn(),
}));

const executionId = '10000000-0000-4000-8000-000000000001';
const scope = {
  accountId: '10000000-0000-4000-8000-000000000002',
  channelId: '10000000-0000-4000-8000-000000000003',
  sessionId: '10000000-0000-4000-8000-000000000004',
  owner: true,
};
const action = {
  action: 'BAN',
  status: 'SUCCEEDED',
  duration_seconds: null,
  execution_id: executionId,
} as const;
const clients: QueryClient[] = [];
function removal(status: UnbanSummary['status'] = 'SUCCEEDED'): UnbanSummary {
  const identity = {
    id: '10000000-0000-4000-8000-000000000005',
    execution_id: executionId,
    requested_at: '2026-10-01T00:00:00Z',
  };
  return status === 'USER_CONFIRMED'
    ? { ...identity, method: 'STUDIO_CONFIRMATION', status, finished_at: '2026-10-01T00:00:01Z' }
    : {
        ...identity,
        method: 'YOUTUBE',
        status,
        finished_at: status === 'DISPATCHED' ? null : '2026-10-01T00:00:01Z',
      };
}
function mount(owner = true, recorded?: UnbanSummary) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const view = render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ChatUnban, {
        action: { ...action, unban: recorded },
        scope: { ...scope, owner },
      }),
    ),
  );
  return { client, ...view };
}
beforeEach(() => {
  vi.mocked(getUnbanHistory).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(requestUnban).mockReset().mockResolvedValue({ removal: removal(), reused: false });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

it('keeps removal outcomes readable without exposing controls to a non-owner', () => {
  mount(false, removal('USER_CONFIRMED'));
  expect(screen.getByText('Unban confirmed by you')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(getUnbanHistory).not.toHaveBeenCalled();
});

it('requires confirmation and cancellation never sends a request', async () => {
  mount();
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Unban viewer' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Unban viewer' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(requestUnban).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(requestUnban).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('sends a scoped provider intent once and refreshes Live and History resources', async () => {
  const { client } = mount();
  const refresh = vi.spyOn(client, 'invalidateQueries');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Unban viewer' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Unban viewer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm unban' }));
  await screen.findByText('Unban confirmed by YouTube');
  expect(requestUnban).toHaveBeenCalledTimes(1);
  expect(requestUnban).toHaveBeenCalledWith(
    { channelId: scope.channelId, sessionId: scope.sessionId, executionId },
    { request_id: expect.any(String), method: 'YOUTUBE' },
  );
  expect(refresh).toHaveBeenCalledWith({
    queryKey: ['live-chat', scope.accountId, scope.channelId, scope.sessionId],
  });
  expect(refresh).toHaveBeenCalledWith({
    queryKey: ['history-action-statistics', scope.accountId, scope.sessionId],
  });
  expect(screen.queryByRole('button', { name: 'Unban viewer' })).toBeNull();
});

it('requires explicit Studio confirmation and labels it separately from YouTube success', async () => {
  vi.mocked(requestUnban).mockResolvedValue({ removal: removal('USER_CONFIRMED'), reused: false });
  mount();
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: 'Already unbanned in YouTube Studio',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Already unbanned in YouTube Studio' }));
  expect(requestUnban).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm already unbanned' }));
  await screen.findByText('Unban confirmed by you');
  expect(vi.mocked(requestUnban).mock.calls[0]?.[1]).toEqual({
    request_id: expect.any(String),
    method: 'STUDIO_CONFIRMATION',
    confirmed: true,
  });
  expect(screen.queryByText('Unban confirmed by YouTube')).toBeNull();
});

it('a lost response requires manual replay with the identical request ID', async () => {
  vi.mocked(requestUnban).mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR'));
  mount();
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Unban viewer' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Unban viewer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm unban' }));
  await screen.findByRole('alert');
  expect(requestUnban).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await screen.findByText('Unban confirmed by YouTube');
  expect(vi.mocked(requestUnban).mock.calls[1]).toEqual(vi.mocked(requestUnban).mock.calls[0]);
});

it('blocks duplicate clicks while the request is awaiting a response', async () => {
  let complete!: (result: Awaited<ReturnType<typeof requestUnban>>) => void;
  vi.mocked(requestUnban).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  mount();
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Unban viewer' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Unban viewer' }));
  const confirm = screen.getByRole('button', { name: 'Confirm unban' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(requestUnban).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Submitting…' }) as HTMLButtonElement).disabled,
    ).toBe(true),
  );
  complete({ removal: removal(), reused: false });
  await screen.findByText('Unban confirmed by YouTube');
});

it.each(['DISPATCHED', 'UNKNOWN'] as const)(
  'keeps %s uncertainty visible without another provider request',
  async (status) => {
    vi.mocked(getUnbanHistory).mockResolvedValue({ items: [removal(status)] });
    mount();
    await screen.findByText('Unban result');
    expect(
      (screen.getByRole('button', { name: 'Unban viewer' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'Already unbanned in YouTube Studio',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(status === 'DISPATCHED');
    expect(requestUnban).not.toHaveBeenCalled();
  },
);

it('does not offer controls if history cannot be verified', async () => {
  vi.mocked(getUnbanHistory).mockRejectedValue(new ApiError(403, 'CHANNEL_FORBIDDEN'));
  mount();
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Unban viewer' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(requestUnban).not.toHaveBeenCalled();
});

it('rejects removal summaries referencing another execution or an unconfirmed ban', () => {
  expect(
    chatAuthorAction.safeParse({
      ...action,
      unban: { ...removal(), execution_id: scope.sessionId },
    }).success,
  ).toBe(false);
  expect(chatAuthorAction.safeParse({ ...action, status: 'UNKNOWN' }).success).toBe(false);
});
