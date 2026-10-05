'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ReactNode } from 'react';

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      // The server bootstrap runs before hydration. Client-created scripts must be inert;
      // next-themes effects apply preferences after client mounts and theme changes.
      scriptProps={{
        type: typeof window === 'undefined' ? 'text/javascript' : 'application/x-theme-bootstrap',
      }}
    >
      {children}
    </NextThemesProvider>
  );
}
