import { focusManager } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { Providers } from '../app/providers.js';
import { SessionGuard } from '../features/auth/components/session-guard.js';

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function advance(ms = 20) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it('preserves an idle dashboard when the real session request fails on window focus', async () => {
  vi.useFakeTimers();
  const body = {
    account: { id: '10000000-0000-4000-8000-000000000001', display_name: 'Andre' },
    memberships: [],
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  render(
    createElement(
      Providers,
      null,
      createElement(
        SessionGuard,
        null,
        createElement('div', { 'data-testid': 'idle-dashboard' }, 'No monitoring active'),
      ),
    ),
  );
  await advance();
  const dashboard = screen.getByTestId('idle-dashboard');
  fetch.mockRejectedValue(new TypeError('Failed to fetch'));
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await advance();
  expect(screen.getByTestId('idle-dashboard')).toBe(dashboard);
  expect(screen.getByText(/Connection interrupted/)).toBeTruthy();
  expect(screen.queryByText('Unable to verify your session')).toBeNull();
  fetch.mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
  await advance(5000);
  expect(screen.getByTestId('idle-dashboard')).toBe(dashboard);
  expect(screen.queryByText(/Connection interrupted/)).toBeNull();
  expect(mocks.replace).not.toHaveBeenCalled();
});
