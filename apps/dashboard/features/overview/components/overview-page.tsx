'use client';

import type { SavedSession } from '@moderator/contracts';
import {
  ArrowRight,
  Check,
  History,
  MessageSquare,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { useSession } from '@/features/auth/hooks/use-session';
import { useHistoryActionStatistics } from '@/features/history/hooks/use-history-action-statistics';
import { useHistoryStatistics } from '@/features/history/hooks/use-history-statistics';
import { useSavedSessions } from '@/features/live/hooks/use-saved-sessions';

const sessionLabels: Record<NonNullable<SavedSession['latest_status']>, string> = {
  STARTING: 'Starting monitoring',
  RUNNING: 'Monitoring started',
  STOPPING: 'Stopping monitoring',
  STOPPED: 'Monitoring ended',
  FAILED: 'Monitoring stopped unexpectedly',
};

export function OverviewPage() {
  const session = useSession();
  if (session.isError)
    return (
      <LoadError
        text="We couldn’t load your account."
        retry={() => void session.refetch()}
        busy={session.isFetching}
      />
    );
  if (!session.data) return <p role="status">Loading your overview…</p>;
  return (
    <OverviewContent
      key={session.data.account.id}
      accountId={session.data.account.id}
      name={session.data.account.display_name}
    />
  );
}

function OverviewContent({ accountId, name }: { accountId: string; name: string }) {
  const sessions = useSavedSessions(accountId);
  const monitoring = useSavedSessions(accountId, '', 'RUNNING');
  const latest = sessions.isError ? undefined : sessions.data?.pages[0]?.items[0];
  const active = monitoring.isError ? undefined : monitoring.data?.pages[0]?.items[0];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Overview
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Welcome back{name ? `, ${name}` : ''}.
          </h1>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            Your stream, at a glance. Check your latest chat activity and choose what to do next.
          </p>
        </div>
        <Button asChild>
          <Link href="/live">
            <Radio aria-hidden="true" />
            Open Live
          </Link>
        </Button>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <section
          aria-labelledby="current-stream-heading"
          className="flex flex-col rounded-2xl border bg-card p-6 sm:p-8"
        >
          <div className="mb-6 flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
              <Radio className="size-5" aria-hidden="true" />
            </span>
            <h2 id="current-stream-heading" className="font-semibold">
              Your livestream
            </h2>
          </div>
          {monitoring.isError ? (
            <LoadError
              text="We couldn’t check your monitoring sessions."
              retry={() => void monitoring.refetch()}
              busy={monitoring.isFetching}
            />
          ) : monitoring.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Checking your monitoring sessions…
            </p>
          ) : active ? (
            <div className="space-y-4">
              <p className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                Monitoring started
              </p>
              <h3 className="wrap-break-word text-2xl font-semibold tracking-tight">
                {active.title || 'Untitled livestream'}
              </h3>
              <p className="text-sm leading-6 text-muted-foreground">
                Open Live to check your chat, AI availability, and moderation results.
              </p>
              <Button asChild variant="outline">
                <Link href="/live">
                  Open live chat
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <h3 className="text-2xl font-semibold tracking-tight">Ready for your next stream?</h3>
              <p className="max-w-lg text-sm leading-6 text-muted-foreground">
                Open Live to find your broadcast and start monitoring its chat.
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                You can review saved streams here even when you’re not live.
              </p>
            </div>
          )}
        </section>

        <aside
          aria-labelledby="prepare-heading"
          className="rounded-2xl border bg-muted/30 p-6 sm:p-8"
        >
          <h2 id="prepare-heading" className="font-semibold">
            Before you go live
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            A few settings help moderation work the way you want.
          </p>
          <div className="mt-6 space-y-5">
            <div className="flex gap-3">
              <Check className="mt-0.5 size-5 shrink-0 text-emerald-700" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium">You’re signed in</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Review your settings before starting your next stream.
                </p>
              </div>
            </div>
            <PreparationLink
              title="Review your blocked words"
              description="Choose words to block and what happens when they appear."
            />
            <PreparationLink
              title="Choose your AI action limits"
              description="Decide when AI can delete a message, time out a viewer, or hide them from chat."
            />
          </div>
          <p className="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
            Saved changes apply when you start a new monitoring session.
          </p>
        </aside>
      </div>

      <section aria-labelledby="latest-stream-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="latest-stream-heading" className="text-lg font-semibold">
              Latest saved stream
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A quick look at the chat and actions recorded for your most recently saved stream.
            </p>
          </div>
          <Link
            href="/history"
            className="inline-flex items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
          >
            View all streams
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        {sessions.isError ? (
          <LoadError
            text="We couldn’t load your saved streams."
            retry={() => void sessions.refetch()}
            busy={sessions.isFetching}
          />
        ) : sessions.isPending ? (
          <p role="status">Loading your saved streams…</p>
        ) : latest ? (
          <div className="rounded-2xl border bg-card p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-2">
                <h3 className="wrap-break-word text-lg font-semibold">
                  {latest.title || 'Untitled livestream'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {latest.latest_status ? sessionLabels[latest.latest_status] : 'Saved stream'} ·
                  Saved{' '}
                  <time dateTime={latest.created_at}>
                    {new Date(latest.created_at).toLocaleDateString('en', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </time>
                </p>
              </div>
              <Button asChild variant="outline">
                <Link href={`/history/${latest.session_id}`}>View stream report</Link>
              </Button>
            </div>
            <LatestStreamSummary
              key={`${accountId}:${latest.session_id}`}
              accountId={accountId}
              sessionId={latest.session_id}
            />
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed p-8">
            <History className="mb-4 size-6 text-muted-foreground" aria-hidden="true" />
            <h3 className="font-semibold">Your first stream report starts here</h3>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Start monitoring a livestream to save its chat and moderation results. You can come
              back to review them after the stream.
            </p>
            <Button asChild variant="outline" className="mt-5">
              <Link href="/live">Find your livestream</Link>
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function LatestStreamSummary({ accountId, sessionId }: { accountId: string; sessionId: string }) {
  const messages = useHistoryStatistics(accountId, sessionId);
  const actions = useHistoryActionStatistics(accountId, sessionId);
  const confirmed = actions.data
    ? actions.data.delete.succeeded + actions.data.timeout.succeeded + actions.data.ban.succeeded
    : undefined;
  return (
    <div className="mt-6 space-y-3 border-t pt-6">
      <dl className="grid gap-3 sm:grid-cols-3">
        <SummaryStat
          label="Chat messages"
          value={messages.isError ? undefined : messages.data?.total_messages}
          loading={messages.isPending}
          icon={<MessageSquare className="size-4" aria-hidden="true" />}
        />
        <SummaryStat
          label="Messages flagged"
          value={messages.isError ? undefined : messages.data?.flagged_messages}
          loading={messages.isPending}
          icon={<ShieldCheck className="size-4" aria-hidden="true" />}
        />
        <SummaryStat
          label="Actions confirmed"
          value={actions.isError ? undefined : confirmed}
          loading={actions.isPending}
          icon={<Check className="size-4" aria-hidden="true" />}
        />
      </dl>
      <p className="text-xs leading-5 text-muted-foreground">
        Flagged messages come from chat-rule checks. Confirmed actions include message deletions,
        timeouts, and viewers hidden from chat.
      </p>
      {(messages.isError || actions.isError) && (
        <LoadError
          text="Some stream totals are unavailable. You can try again or open the full report."
          busy={messages.isFetching || actions.isFetching}
          retry={() => {
            if (messages.isError) void messages.refetch();
            if (actions.isError) void actions.refetch();
          }}
        />
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  loading,
  icon,
}: {
  label: string;
  value?: number;
  loading: boolean;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-xl bg-muted/40 p-4">
      <dt className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-3 text-2xl font-semibold tabular-nums">
        {loading ? (
          <span className="text-sm font-normal">Loading…</span>
        ) : value === undefined ? (
          <span className="text-sm font-normal">Unavailable</span>
        ) : (
          value.toLocaleString('en')
        )}
      </dd>
    </div>
  );
}

function PreparationLink({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex gap-3">
      <SlidersHorizontal
        className="mt-0.5 size-5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div>
        <Link
          href="/settings/moderation"
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {title}
        </Link>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function LoadError({ text, retry, busy }: { text: string; retry: () => void; busy: boolean }) {
  return (
    <div className="space-y-3">
      <p role="alert" className="text-sm text-muted-foreground">
        {text}
      </p>
      <Button variant="outline" size="sm" onClick={retry} disabled={busy}>
        {busy ? 'Trying again…' : 'Try again'}
      </Button>
    </div>
  );
}
