'use client';
import { Alert } from '@/components/ui/alert';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/api-client';

import { useSession } from '../hooks/use-session';
import { GoogleLoginCard } from './google-login-card';

function LoginContent() {
  const session = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = searchParams.get('auth');
  const failed = auth === 'failed';

  useEffect(() => {
    if (session.isSuccess && session.data && !failed) {
      router.replace('/live');
    }
  }, [session.isSuccess, session.data, failed, router]);

  if (session.isPending || (session.data && !failed && !session.isError)) {
    return <p role="status">Checking your session…</p>;
  }

  if (session.isError) {
    return (
      <div className="space-y-4">
        <Alert role="alert" className="text-sm text-destructive">
          {getErrorMessage(session.error)}
        </Alert>
        <Button disabled={session.isFetching} onClick={() => void session.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md space-y-6">
      <div className="space-y-2 text-center">
        <p className="text-xs font-semibold tracking-widest text-muted-foreground">
          AI TOXIC MODERATOR
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Welcome back</h1>
      </div>

      {failed && (
        <Alert role="alert" className="text-sm text-destructive">
          Google sign-in was not completed. Please try again.
        </Alert>
      )}

      {auth === 'expired' && !session.data && (
        <p role="status" className="text-sm text-muted-foreground">
          Your session has ended. Please sign in again.
        </p>
      )}

      <GoogleLoginCard />

      <div className="flex justify-center gap-4 text-sm">
        <Link href="/" className="underline underline-offset-4">
          Back to home
        </Link>

        {session.data && (
          <Link href="/live" className="underline underline-offset-4">
            Return to dashboard
          </Link>
        )}
      </div>
    </div>
  );
}

export function LoginPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-6 py-12">
      <Suspense fallback={<p role="status">Loading sign-in…</p>}>
        <LoginContent />
      </Suspense>
    </main>
  );
}
