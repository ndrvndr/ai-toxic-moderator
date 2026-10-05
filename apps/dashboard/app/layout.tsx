import './globals.css';

import type { Metadata } from 'next';
import { Geist } from 'next/font/google';

import { cn } from '@/lib/utils';

import { Providers } from './providers';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'AI Toxic Moderator',
  description: 'Automatic moderation for YouTube Live Chat',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn('font-sans', geist.variable)} suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
