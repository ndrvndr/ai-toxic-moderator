import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import { createElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { ThemeToggle } from '../components/theme-toggle.js';

afterEach(() => {
  cleanup();
  localStorage.removeItem('theme');
  document.documentElement.classList.remove('light', 'dark');
});
function show() {
  return render(
    createElement(
      ThemeProvider,
      { attribute: 'class', defaultTheme: 'light', enableSystem: false },
      createElement(ThemeToggle),
    ),
  );
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
