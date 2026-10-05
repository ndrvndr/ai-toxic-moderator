import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../components/theme-provider.js';
import { ThemeToggle } from '../components/theme-toggle.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem('theme');
  document.documentElement.classList.remove('light', 'dark');
});
function show() {
  return render(createElement(ThemeProvider, null, createElement(ThemeToggle)));
}
it('switches themes and remembers the choice after remounting', async () => {
  const view = show();
  fireEvent.click(await screen.findByRole('button', { name: 'Switch to dark theme' }));
  await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
  expect(localStorage.getItem('theme')).toBe('dark');
  view.unmount();
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Switch to light theme' }));
  await waitFor(() => expect(document.documentElement.classList.contains('light')).toBe(true));
  expect(localStorage.getItem('theme')).toBe('light');
});

it('keeps client-mounted theme scripts inert without React script warnings', () => {
  const error = vi.spyOn(console, 'error');
  const view = show();
  expect(view.container.querySelector('script')?.type).toBe('application/x-theme-bootstrap');
  expect(
    error.mock.calls.some((args) =>
      args.some((arg) => String(arg).includes('Encountered a script tag')),
    ),
  ).toBe(false);
});

it('retains an executable server bootstrap for the initial page load', () => {
  // next-themes was imported in jsdom; avoid its cached client-only system lookup here.
  localStorage.setItem('theme', 'light');
  vi.stubGlobal('window', undefined);
  try {
    const html = renderToString(createElement(ThemeProvider, null, 'Server content'));
    expect(html).toContain('type="text/javascript"');
    expect(html).toContain('localStorage.getItem');
    expect(html).not.toContain('application/x-theme-bootstrap');
  } finally {
    vi.unstubAllGlobals();
  }
});
