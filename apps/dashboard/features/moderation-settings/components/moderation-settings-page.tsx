'use client';

import { useState } from 'react';

import { useSession } from '@/features/auth/hooks/use-session';
import { getErrorMessage } from '@/lib/api-client';

import { AiModerationSettingsEditor } from './ai-moderation-settings-editor';
import { CustomBlacklistEditor } from './custom-blacklist-editor';
import { ModerationSettingsEditor } from './moderation-settings-editor';

export function ModerationSettingsPage() {
  const session = useSession();
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Moderation settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure automatic action preferences for your channel.
        </p>
      </header>
      <p className="rounded-lg border p-4 text-sm">
        Saved settings apply when a new monitoring run starts. Changes do not affect an existing
        run. Automatic actions also require the corresponding worker action switches to be enabled.
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
        No accessible channels yet. Start monitoring a broadcast from your connected account to
        register its channel.
      </p>
    );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
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
      </div>
      <ModerationSettingsEditor
        accountId={accountId}
        channelId={active.channel_id}
        canEdit={active.role === 'OWNER'}
      />
      <section
        aria-labelledby="custom-blacklist-heading"
        className="space-y-4 rounded-lg border p-5"
      >
        <h2 id="custom-blacklist-heading" className="text-lg font-semibold">
          Custom blacklist
        </h2>
        <p className="text-sm text-muted-foreground">
          Configure words, phrases, and domains with separate actions for each entry. Enabled
          entries apply to new monitoring runs. Deletion and author actions also require their
          corresponding worker action switches to be enabled.
        </p>
        <CustomBlacklistEditor
          accountId={accountId}
          channelId={active.channel_id}
          canEdit={active.role === 'OWNER'}
        />
      </section>
      <section aria-labelledby="ai-settings-heading" className="space-y-4 rounded-lg border p-5">
        <h2 id="ai-settings-heading" className="text-lg font-semibold">
          AI moderation thresholds
        </h2>
        <p className="text-sm text-muted-foreground">
          AI thresholds apply to new monitoring runs. Automatic actions require enabled AI settings,
          AI processing for the run, and the corresponding worker action switches. Custom blacklist
          matches and selected built-in rule actions take priority.
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
