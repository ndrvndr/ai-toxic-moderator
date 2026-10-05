'use client';

import { useState } from 'react';

import { useSession } from '@/features/auth/hooks/use-session';
import { getErrorMessage } from '@/lib/api-client';

import { AiModerationSettingsEditor } from './ai-moderation-settings-editor';
import { CustomBlacklistEditor } from './custom-blacklist-editor';

export function ModerationSettingsPage() {
  const session = useSession();
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Moderation settings</h1>
        <p className="text-sm text-muted-foreground">
          Choose what gets blocked and when moderation should take action in your chat.
        </p>
      </header>
      <p className="rounded-xl border bg-muted/30 p-5 text-sm leading-6">
        Save each section when you’re done. Your changes apply the next time you start monitoring,
        not to a session already running. Check Live for AI availability and confirmed action
        results.
      </p>
      {session.isPending ? (
        <p role="status">Loading account…</p>
      ) : session.isError ? (
        <p role="alert">{getErrorMessage(session.error)}</p>
      ) : session.data ? (
        <ChannelSettings
          key={session.data.account.id}
          accountId={session.data.account.id}
          memberships={session.data.memberships}
        />
      ) : (
        <p role="alert">Please sign in to view moderation settings.</p>
      )}
    </div>
  );
}

function ChannelSettings({
  accountId,
  memberships,
}: {
  accountId: string;
  memberships: { channel_id: string; role: 'OWNER' | 'MODERATOR' | 'OPERATOR' }[];
}) {
  const [selected, setSelected] = useState('');
  const channels = memberships.filter((membership) =>
    ['OWNER', 'MODERATOR'].includes(membership.role),
  );
  const active = channels.find((membership) => membership.channel_id === selected) ?? channels[0];
  if (!active)
    return (
      <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
        No channel is available yet. Start monitoring your stream from Live to set up its channel
        here.
      </p>
    );

  return (
    <div className="space-y-6">
      <div className="space-y-2 rounded-xl border p-5">
        {channels.length > 1 ? (
          <>
            <label htmlFor="settings-channel" className="text-sm font-medium">
              Channel
            </label>
            <select
              id="settings-channel"
              value={active.channel_id}
              onChange={(event) => setSelected(event.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {channels.map((membership) => (
                <option key={membership.channel_id} value={membership.channel_id}>
                  {membership.channel_id} · {membership.role}
                </option>
              ))}
            </select>
          </>
        ) : (
          <p className="text-sm font-medium">Settings for your channel</p>
        )}
        <p className="text-xs text-muted-foreground">
          {active.role === 'OWNER'
            ? 'You can edit and save these settings.'
            : 'You can review these settings. Only the channel owner can save changes.'}
        </p>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Channel details</summary>
          <p className="mt-2 break-all">{active.channel_id}</p>
        </details>
      </div>
      <nav
        aria-label="Moderation settings sections"
        className="flex flex-wrap gap-4 text-sm font-medium"
      >
        <a href="#blocked-words" className="underline underline-offset-4">
          Blocked words
        </a>
        <a href="#ai-action-limits" className="underline underline-offset-4">
          AI action limits
        </a>
      </nav>
      <section
        id="blocked-words"
        aria-labelledby="custom-blacklist-heading"
        className="scroll-mt-6 space-y-5 rounded-2xl border bg-card p-5 sm:p-6"
      >
        <h2 id="custom-blacklist-heading" className="text-lg font-semibold">
          Blocked words
        </h2>
        <p className="text-sm text-muted-foreground">
          Add words, phrases, or website domains you don’t want in chat. Each match selects message
          deletion, with an optional timeout or ban for the viewer. These rules take priority over
          AI.
        </p>
        <CustomBlacklistEditor
          accountId={accountId}
          channelId={active.channel_id}
          canEdit={active.role === 'OWNER'}
        />
      </section>
      <section
        id="ai-action-limits"
        aria-labelledby="ai-settings-heading"
        className="scroll-mt-6 space-y-5 rounded-2xl border bg-card p-5 sm:p-6"
      >
        <h2 id="ai-settings-heading" className="text-lg font-semibold">
          AI action limits
        </h2>
        <p className="text-sm text-muted-foreground">
          Choose when AI can delete a message, time out a viewer, or ban them. Blocked words take
          priority. A selected action still needs a confirmed result from YouTube.
        </p>
        <AiModerationSettingsEditor
          accountId={accountId}
          channelId={active.channel_id}
          canEdit={active.role === 'OWNER'}
        />
      </section>
    </div>
  );
}
