'use client';

import { useSession } from '@/features/auth/hooks/use-session';

import { HistorySessionList } from './history-session-list';

export function HistoryPage() {
  const session = useSession();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Livestream history</h1>
        <p className="text-sm text-muted-foreground">
          Browse saved monitoring sessions and review their stored chat and moderation results.
        </p>
      </header>

      {session.data && (
        <HistorySessionList key={session.data.account.id} accountId={session.data.account.id} />
      )}
    </div>
  );
}
