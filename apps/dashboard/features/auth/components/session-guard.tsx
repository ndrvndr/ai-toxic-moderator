'use client';
import { Alert } from '@/components/ui/alert';

import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { getErrorMessage, isTemporaryApiError } from '@/lib/api-client';

import { useSession } from '../hooks/use-session';

export function SessionGuard({ children }: { children: ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (session.isSuccess && session.data === null) {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'auth',
      });

      router.replace('/login?auth=expired');
    }
  }, [session.isSuccess, session.data, queryClient, router]);

  const recovering = session.isError && isTemporaryApiError(session.error);

  if (session.isError && !(recovering && session.data)) {
    return (
      <main className="mx-auto max-w-lg space-y-4 px-6 py-16">
        <h1 className="text-xl font-semibold">Unable to verify your session</h1>
        <Alert role="alert" className="text-sm text-destructive">
          {getErrorMessage(session.error)}
        </Alert>
        <Button disabled={session.isFetching} onClick={() => void session.refetch()}>
          {session.isFetching ? 'Retrying…' : 'Try again'}
        </Button>
      </main>
    );
  }

  if (!session.data) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-16">
        <div role="status" className="flex max-w-sm flex-col items-center gap-3 text-center">
          <LoaderCircle aria-hidden="true" className="size-6 animate-spin text-muted-foreground" />
          <p className="font-medium">Checking your session…</p>
          <p className="text-sm text-muted-foreground">Getting your dashboard ready.</p>
        </div>
      </main>
    );
  }

  return (
    <>
      {recovering && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-center gap-3 border-b bg-muted px-4 py-3 text-sm"
        >
          <p>
            Connection interrupted. Reconnecting automatically. Displayed information may be out of
            date.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={session.isFetching}
            onClick={() => void session.refetch()}
          >
            {session.isFetching ? 'Reconnecting…' : 'Retry connection'}
          </Button>
        </div>
      )}
      {children}
    </>
  );
}
