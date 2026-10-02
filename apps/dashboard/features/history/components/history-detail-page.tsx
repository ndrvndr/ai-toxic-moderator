'use client';

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { useSession } from '@/features/auth/hooks/use-session';

import { HistorySessionDetail } from './history-session-detail';

export function HistoryDetailPage({ sessionId }: { sessionId: string }) {
  const session = useSession();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Button asChild variant="outline">
        <Link href="/history">Back to history</Link>
      </Button>

      {session.data && (
        <HistorySessionDetail
          key={`${session.data.account.id}:${sessionId}`}
          accountId={session.data.account.id}
          sessionId={sessionId}
        />
      )}
    </div>
  );
}
