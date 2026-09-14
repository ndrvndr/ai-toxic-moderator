import './globals.css';

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI Toxic Moderator · Foundation',
  description: 'Fondasi dashboard moderasi lokal',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
