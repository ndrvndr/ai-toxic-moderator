import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLiveEvents } from '../features/live/hooks/use-live-events.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly url: string;

  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  close = vi.fn((code = 1000, reason = '') => {
    this.onclose?.(new CloseEvent('close', { code, reason }));
  });

  receive(value: unknown) {
    this.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify(value),
      }),
    );
  }

  disconnect(code = 1006) {
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

const accountId = '10000000-0000-4000-8000-000000000001';
const channelId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const runId = '40000000-0000-4000-8000-000000000004';
const broadcastId = 'test-broadcast';

const chatKey = ['live-chat', accountId, channelId, sessionId] as const;
const monitoringKey = ['monitoring', accountId, broadcastId] as const;
const unrelatedKey = ['live-chat', 'another-account', channelId, sessionId] as const;

let client: QueryClient;
let unsubscribe: Array<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.stubGlobal('WebSocket', MockWebSocket);
  MockWebSocket.instances = [];
  unsubscribe = [];

  client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
      },
    },
  });
});

afterEach(() => {
  cleanup();

  for (const stop of unsubscribe) {
    stop();
  }

  client.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function observe(key: readonly string[]) {
  let revision = 0;
  const queryFn = vi.fn(async () => ++revision);

  client.setQueryData(key, 0);

  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn,
    staleTime: Infinity,
  });

  unsubscribe.push(observer.subscribe(() => {}));

  return queryFn;
}

function mount() {
  return renderHook(
    () =>
      useLiveEvents({
        accountId,
        broadcastId,
        channelId,
        sessionId,
      }),
    {
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client }, children),
    },
  );
}

function latestSocket() {
  const socket = MockWebSocket.instances.at(-1);

  if (!socket) throw new Error('No WebSocket was created.');

  return socket;
}

function ready(socket: MockWebSocket, cursor: string) {
  act(() => {
    socket.receive({
      type: 'ready',
      channel_id: channelId,
      session_id: sessionId,
      cursor,
    });
  });
}

function event(
  socket: MockWebSocket,
  sequence: string,
  type: 'chat.updated' | 'monitoring.updated' = 'chat.updated',
) {
  act(() => {
    socket.receive({
      type: 'events',
      channel_id: channelId,
      session_id: sessionId,
      cursor: sequence,
      items: [
        {
          sequence,
          run_id: runId,
          event_type: type,
        },
      ],
    });
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe('useLiveEvents', () => {
  it('refreshes the initial snapshot and only the affected cache afterward', async () => {
    const chat = observe(chatKey);
    const monitoring = observe(monitoringKey);
    const unrelated = observe(unrelatedKey);
    const hook = mount();
    const socket = latestSocket();

    expect(hook.result.current).toBe('connecting');

    ready(socket, '0');
    await advance(250);

    expect(hook.result.current).toBe('connected');
    expect(client.getQueryData(chatKey)).toBe(1);
    expect(client.getQueryData(monitoringKey)).toBe(1);
    expect(unrelated).not.toHaveBeenCalled();

    event(socket, '1');
    await advance(250);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(monitoring).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(chatKey)).toBe(2);

    event(socket, '2', 'monitoring.updated');
    await advance(250);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(monitoring).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(unrelatedKey)).toBe(0);
  });

  it('reconnects with the last processed cursor and accepts replay', async () => {
    const chat = observe(chatKey);
    observe(monitoringKey);
    const hook = mount();
    const first = latestSocket();

    ready(first, '5');
    await advance(250);

    event(first, '6');
    await advance(250);

    act(() => first.disconnect());

    expect(hook.result.current).toBe('reconnecting');

    await advance(1000);

    const second = latestSocket();
    expect(second).not.toBe(first);

    const url = new URL(second.url);

    expect(url.searchParams.get('after')).toBe('6');
    expect(url.searchParams.get('channel_id')).toBe(channelId);
    expect(url.searchParams.get('session_id')).toBe(sessionId);

    ready(second, '6');
    event(second, '7');
    await advance(250);

    expect(hook.result.current).toBe('connected');
    expect(chat).toHaveBeenCalledTimes(3);
    expect(client.getQueryData(chatKey)).toBe(3);
  });

  it('closes the connection and cancels scheduled work on unmount', async () => {
    const chat = observe(chatKey);
    const hook = mount();
    const socket = latestSocket();

    ready(socket, '0');

    hook.unmount();
    await advance(60_000);

    expect(socket.close).toHaveBeenCalledWith(1000, 'Live view closed.');
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it('cancels a pending reconnect on unmount', async () => {
    const hook = mount();
    const socket = latestSocket();

    ready(socket, '0');
    act(() => socket.disconnect());

    expect(hook.result.current).toBe('reconnecting');

    hook.unmount();
    await advance(60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it.each([
    [4001, 'unauthenticated'],
    [4003, 'forbidden'],
    [4004, 'forbidden'],
  ] as const)(
    'stops reconnecting and removes chat after close code %s',
    async (code, expectedStatus) => {
      client.setQueryData(chatKey, { private: true });

      const hook = mount();
      const socket = latestSocket();

      ready(socket, '0');
      act(() => socket.disconnect(code));
      await advance(60_000);

      expect(hook.result.current).toBe(expectedStatus);
      expect(client.getQueryData(chatKey)).toBeUndefined();
      expect(MockWebSocket.instances).toHaveLength(1);
    },
  );

  it('keeps a refresh pending when an event arrives during an active request', async () => {
    const chat = observe(chatKey);
    const hook = mount();
    const socket = latestSocket();

    ready(socket, '0');
    await advance(250);

    let resolveRequest!: (value: number) => void;

    chat.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    event(socket, '1');
    await advance(250);

    expect(chat).toHaveBeenCalledTimes(2);

    event(socket, '2');
    await advance(250);

    // The current request must finish before another refresh starts.
    expect(chat).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRequest(50);
      await Promise.resolve();
    });

    await advance(250);

    expect(chat).toHaveBeenCalledTimes(3);
    expect(hook.result.current).toBe('connected');
  });

  it('stops after the configured reconnect attempts are exhausted', async () => {
    const hook = mount();

    for (const backoff of [1000, 2000, 4000, 8000, 16000, 30000]) {
      act(() => latestSocket().disconnect());
      await advance(backoff);
    }

    act(() => latestSocket().disconnect());

    expect(hook.result.current).toBe('unavailable');
    expect(MockWebSocket.instances).toHaveLength(7);

    await advance(60_000);

    expect(MockWebSocket.instances).toHaveLength(7);
  });
});
