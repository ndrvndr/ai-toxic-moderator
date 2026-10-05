'use client';
import { Alert } from '@/components/ui/alert';

import { Button } from '@/components/ui/button';
import { isBlacklistAccessError, useCustomBlacklist } from '../hooks/use-custom-blacklist';
import { CustomBlacklistForm } from './custom-blacklist-form';

type Props = { accountId: string; channelId: string; canEdit: boolean };

export function CustomBlacklistEditor(props: Props) {
  return <EditorContent key={`${props.accountId}:${props.channelId}`} {...props} />;
}

function EditorContent(props: Props) {
  const query = useCustomBlacklist(props.accountId, props.channelId);
  if (query.isError)
    return (
      <div className="space-y-3">
        <Alert role="alert">
          {isBlacklistAccessError(query.error)
            ? 'You no longer have access to this blacklist. Verify your account and channel permissions.'
            : 'Unable to load the blacklist.'}
        </Alert>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry loading blacklist
        </Button>
      </div>
    );
  if (query.isPending) return <p role="status">Loading blacklist…</p>;
  return (
    <CustomBlacklistForm
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
