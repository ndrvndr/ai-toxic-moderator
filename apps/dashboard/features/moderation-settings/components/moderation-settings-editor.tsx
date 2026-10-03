'use client';

import { Button } from '@/components/ui/button';
import { ApiError, getErrorMessage } from '@/lib/api-client';

import { useModerationRuleCatalog, useModerationSettings } from '../hooks/use-moderation-settings';
import { ModerationSettingsForm } from './moderation-settings-form';

type Props = { accountId: string; channelId: string; canEdit: boolean };

export function ModerationSettingsEditor(props: Props) {
  return <EditorContent key={`${props.accountId}:${props.channelId}`} {...props} />;
}

function EditorContent({ accountId, channelId, canEdit }: Props) {
  const settings = useModerationSettings(accountId, channelId);
  const catalog = useModerationRuleCatalog(accountId, channelId);
  const error = settings.error ?? catalog.error;
  if (settings.isError || catalog.isError) {
    const accessError = error instanceof ApiError && [401, 403, 404].includes(error.status);
    return (
      <section className="space-y-3 rounded-lg border p-5">
        <p role="alert" className="text-sm text-destructive">
          {accessError
            ? 'Settings are unavailable. Check your session and channel access.'
            : getErrorMessage(error)}
        </p>
        {!accessError && (
          <Button
            variant="outline"
            disabled={settings.isFetching || catalog.isFetching}
            onClick={() => {
              void settings.refetch();
              void catalog.refetch();
            }}
          >
            Try again
          </Button>
        )}
      </section>
    );
  }
  if (settings.isPending || catalog.isPending)
    return <p role="status">Loading moderation settings…</p>;

  return (
    <ModerationSettingsForm
      accountId={accountId}
      channelId={channelId}
      canEdit={canEdit}
      settings={settings.data}
      catalog={catalog.data}
      onReload={async () => {
        const [result, rules] = await Promise.all([settings.refetch(), catalog.refetch()]);
        if (!result.isSuccess || !rules.isSuccess) {
          throw result.error ?? rules.error ?? new Error('Unable to reload settings.');
        }
        return result.data;
      }}
    />
  );
}
