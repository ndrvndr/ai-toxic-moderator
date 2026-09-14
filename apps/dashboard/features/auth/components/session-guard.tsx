'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/api-client';

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

  if (session.isError) {
    return (
      <main className="mx-auto max-w-lg space-y-4 px-6 py-16">
        <h1 className="text-xl font-semibold">Unable to verify your session</h1>
        <p role="alert" className="text-sm text-destructive">
          {getErrorMessage(session.error)}
        </p>
        <Button disabled={session.isFetching} onClick={() => void session.refetch()}>
          {session.isFetching ? 'Retrying…' : 'Try again'}
        </Button>
      </main>
    );
  }

  if (!session.data) {
    return (
      <main className="px-6 py-16">
        <p role="status" className="text-sm text-muted-foreground">
          Checking your session…
        </p>
      </main>
    );
  }

  return children;
}
