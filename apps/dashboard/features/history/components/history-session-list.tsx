'use client';
import { Alert } from '@/components/ui/alert';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { getErrorMessage } from '@/lib/api-client';
import type { SavedSession } from '@moderator/contracts';
import { useHistoryPage } from '../hooks/use-history-page';

import { HistorySessionCard } from './history-session-card';

type HistorySessionListProps = {
  accountId: string;
  search?: string;
  status?: NonNullable<SavedSession['latest_status']>;
  page?: number;
  take?: number;
};

export function HistorySessionList({
  accountId,
  search = '',
  status,
  page = 1,
  take = 10,
}: HistorySessionListProps) {
  const router = useRouter();
  const sessions = useHistoryPage(accountId, search, status, page, take);
  const hasFilters = search !== '' || status !== undefined;

  const items = sessions.data?.items ?? [];
  function pageUrl(next: number) {
    const params = new URLSearchParams({ page: String(next), take: String(take) });
    if (search) params.set('q', search);
    if (status) params.set('status', status);
    return `/history?${params}`;
  }

  if (sessions.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading livestream history…
      </p>
    );
  }

  if (sessions.isError) {
    return (
      <div className="space-y-3 rounded-lg border p-5">
        <Alert role="alert" className="text-sm text-destructive">
          {getErrorMessage(sessions.error)}
        </Alert>

        <Button
          variant="outline"
          disabled={sessions.isFetching}
          onClick={() => void sessions.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Newest saved streams first. Viewing a report does not start monitoring.
        </p>

        <Button
          variant="outline"
          disabled={sessions.isFetching}
          onClick={() => void sessions.refetch()}
        >
          {sessions.isRefetching ? 'Refreshing…' : 'Refresh history'}
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-dashed p-8">
          <h2 className="font-medium">
            {page > 1
              ? 'No sessions on this page'
              : hasFilters
                ? 'No matching sessions'
                : 'No saved sessions yet'}
          </h2>

          <p className="text-sm text-muted-foreground">
            {page > 1
              ? 'Return to the first page to see the available streams.'
              : hasFilters
                ? 'Try another title or monitoring status, or clear the filters.'
                : 'Sessions will appear here after you start monitoring a livestream.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((session) => (
            <li key={session.session_id}>
              <HistorySessionCard session={session} />
            </li>
          ))}
        </ul>
      )}

      {sessions.data && (
        <>
          <p className="text-sm text-muted-foreground">
            Page {page} of {Math.max(1, sessions.data.total_pages)} · {sessions.data.total} streams
            · {take} per page
          </p>
          <Pagination
            aria-label="History pages"
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              const link = (event.target as HTMLElement).closest('a');
              const href = link?.getAttribute('href');
              if (href && link?.getAttribute('aria-disabled') !== 'true') {
                event.preventDefault();
                router.push(href);
              }
            }}
          >
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href={page > 1 ? pageUrl(page - 1) : undefined}
                  aria-disabled={page <= 1}
                  className={page <= 1 ? 'pointer-events-none opacity-50' : ''}
                  tabIndex={page <= 1 ? -1 : 0}
                />
              </PaginationItem>
              {[
                ...new Set([
                  1,
                  ...Array.from({ length: 5 }, (_, i) => page - 2 + i),
                  sessions.data.total_pages,
                ]),
              ]
                .filter((number) => number >= 1 && number <= sessions.data!.total_pages)
                .sort((a, b) => a - b)
                .map((number) => (
                  <PaginationItem key={number}>
                    <PaginationLink href={pageUrl(number)} isActive={number === page}>
                      {number}
                    </PaginationLink>
                  </PaginationItem>
                ))}
              <PaginationItem>
                <PaginationNext
                  href={page < sessions.data.total_pages ? pageUrl(page + 1) : undefined}
                  aria-disabled={page >= sessions.data.total_pages}
                  className={
                    page >= sessions.data.total_pages ? 'pointer-events-none opacity-50' : ''
                  }
                  tabIndex={page >= sessions.data.total_pages ? -1 : 0}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
          {page > Math.max(1, sessions.data.total_pages) && (
            <Button asChild variant="outline">
              <a href={pageUrl(1)}>Return to first page</a>
            </Button>
          )}
        </>
      )}
    </div>
  );
}
