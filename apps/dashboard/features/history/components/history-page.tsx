'use client';

import { monitoringStatus } from '@moderator/contracts';

import { useSession } from '@/features/auth/hooks/use-session';

import { HistorySearchForm } from './history-search-form';
import { HistorySessionList } from './history-session-list';

type HistoryPageProps = {
  search?: string;
  status?: string;
};

export function HistoryPage({ search = '', status = '' }: HistoryPageProps) {
  const session = useSession();
  const parsedStatus = monitoringStatus.safeParse(status);

  const invalidStatus = status !== '' && !parsedStatus.success;
  const invalidSearch = search.length > 100;
  const filterKey = JSON.stringify([search, status]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Livestream history</h1>
        <p className="text-sm text-muted-foreground">
          Look back at your streams. See what your viewers said and how moderation handled it.
        </p>
      </header>

      <HistorySearchForm key={filterKey} search={search} status={status} />

      {invalidSearch || invalidStatus ? (
        <p role="alert" className="text-sm text-destructive">
          {invalidSearch
            ? 'Search terms must contain no more than 100 characters.'
            : 'The monitoring status is invalid. Select a valid status or clear the filters.'}
        </p>
      ) : (
        session.data && (
          <HistorySessionList
            key={`${session.data.account.id}:${filterKey}`}
            accountId={session.data.account.id}
            search={search}
            status={parsedStatus.success ? parsedStatus.data : undefined}
          />
        )
      )}
    </div>
  );
}
