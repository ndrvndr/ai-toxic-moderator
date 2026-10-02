'use client';

import { useSession } from '@/features/auth/hooks/use-session';

import { HistorySearchForm } from './history-search-form';
import { HistorySessionList } from './history-session-list';

export function HistoryPage({ search = '' }: { search?: string }) {
  const session = useSession();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Livestream history</h1>
        <p className="text-sm text-muted-foreground">
          Browse saved monitoring sessions and review their stored chat and moderation results.
        </p>
      </header>

      <HistorySearchForm key={search} search={search} />

      {search.length > 100 ? (
        <p role="alert" className="text-sm text-destructive">
          Search terms must contain no more than 100 characters.
        </p>
      ) : (
        session.data && (
          <HistorySessionList
            key={`${session.data.account.id}:${search}`}
            accountId={session.data.account.id}
            search={search}
          />
        )
      )}
    </div>
  );
}
