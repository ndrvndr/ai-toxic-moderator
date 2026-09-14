import './globals.css';

import type { Metadata } from 'next';

import { cn } from '@/lib/utils';
import { Geist } from 'next/font/google';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'AI Toxic Moderator',
  description: 'Dashboard moderasi otomatis YouTube Live Chat',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className={cn('font-sans', geist.variable)}>
      <body>{children}</body>
    </html>
  );
}
