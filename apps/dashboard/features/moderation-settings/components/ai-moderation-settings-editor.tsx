'use client';
import { Alert } from '@/components/ui/alert';

import { Button } from '@/components/ui/button';
import {
  isAiSettingsAccessError,
  useAiModerationSettings,
} from '../hooks/use-ai-moderation-settings';
import { AiModerationSettingsForm } from './ai-moderation-settings-form';

type Props = { accountId: string; channelId: string; canEdit: boolean };

export function AiModerationSettingsEditor(props: Props) {
  return <EditorContent key={`${props.accountId}:${props.channelId}`} {...props} />;
}

function EditorContent(props: Props) {
  const query = useAiModerationSettings(props.accountId, props.channelId);
  if (query.isError && (isAiSettingsAccessError(query.error) || query.data === undefined))
    return (
      <div className="space-y-3">
        <Alert role="alert">
          {isAiSettingsAccessError(query.error)
            ? 'AI settings are unavailable. Verify your account and channel access.'
            : 'Unable to load AI settings.'}
        </Alert>
        <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
          Retry loading AI settings
        </Button>
      </div>
    );
  if (query.isPending || query.data === undefined) return <p role="status">Loading AI settings…</p>;
  return (
    <AiModerationSettingsForm
      {...props}
      initial={query.data}
      onReload={async () => {
        const result = await query.refetch();
        if (!result.isSuccess) throw result.error;
        return result.data;
      }}
    />
  );
}
