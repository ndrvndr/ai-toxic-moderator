'use client';

import type { ChatAuthorAction, UnbanRequest, UnbanSummary } from '@moderator/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { ApiError, getErrorMessage } from '@/lib/api-client';
import { getUnbanHistory, requestUnban } from '../api/unban-api';

export type UnbanScope = {
  accountId: string;
  channelId: string;
  sessionId: string;
  owner: boolean;
};
type BanAction = Extract<ChatAuthorAction, { action: 'BAN' }>;

const descriptions: Record<UnbanSummary['status'], string> = {
  DISPATCHED: 'Unban requested. Waiting for the result. Do not submit another request.',
  SUCCEEDED: 'YouTube confirmed this unban request.',
  USER_CONFIRMED:
    'You confirmed that you removed this viewer from Hidden users in YouTube Studio. This was not independently verified by the app.',
  REJECTED:
    'YouTube rejected the unban request. Check Hidden users in YouTube Studio before deciding what to do next.',
  NOT_SENT: 'The unban request was not sent to YouTube.',
  UNKNOWN:
    'The unban request may or may not have succeeded. It will not be retried automatically. Check Hidden users in YouTube Studio.',
};

function removalError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Please sign in again before removing a ban.';
    if (error.status === 403) return 'Only the channel owner can remove this ban.';
    if (error.code === 'REMOVAL_OUTCOME_UNKNOWN')
      return 'An earlier unban request has an uncertain result. Check YouTube Studio and confirm there if you removed the ban.';
    if (error.code === 'REMOVAL_ALREADY_RECORDED')
      return 'An unban is already pending or confirmed. Check the latest result below.';
  }
  return getErrorMessage(error);
}

function RemovalResult({ removal }: { removal?: UnbanSummary | null }) {
  if (!removal) return null;
  return (
    <div role="status" className="space-y-1 text-xs">
      <p className="font-medium">
        {removal.status === 'SUCCEEDED'
          ? 'Unban confirmed by YouTube'
          : removal.status === 'USER_CONFIRMED'
            ? 'Unban confirmed by you'
            : 'Unban result'}
      </p>
      <p className="text-muted-foreground">{descriptions[removal.status]}</p>
      {['SUCCEEDED', 'USER_CONFIRMED'].includes(removal.status) && (
        <p className="text-muted-foreground">
          New messages can be moderated again. Previous ban and deleted-message records remain in
          this report.
        </p>
      )}
    </div>
  );
}

export function ChatUnban({ action, scope }: { action: BanAction; scope?: UnbanScope }) {
  if (action.status !== 'SUCCEEDED') return null;
  if (!scope?.owner || !action.execution_id) return <RemovalResult removal={action.unban} />;
  return (
    <OwnerUnban
      key={`${scope.accountId}:${scope.channelId}:${scope.sessionId}:${action.execution_id}`}
      action={action}
      scope={scope}
      executionId={action.execution_id}
    />
  );
}

function OwnerUnban({
  action,
  scope,
  executionId,
}: {
  action: BanAction;
  scope: UnbanScope;
  executionId: string;
}) {
  const client = useQueryClient();
  const target = { channelId: scope.channelId, sessionId: scope.sessionId, executionId };
  const key = ['unban', scope.accountId, scope.channelId, scope.sessionId, executionId] as const;
  const [method, setMethod] = useState<UnbanRequest['method'] | null>(null);
  const [request, setRequest] = useState<UnbanRequest | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const history = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      try {
        return await getUnbanHistory(target, signal);
      } catch (error) {
        if (error instanceof ApiError && [401, 403].includes(error.status))
          void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        throw error;
      }
    },
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.items[0]?.status === 'DISPATCHED' ? 2000 : false,
  });
  const removal = history.data?.items[0] ?? action.unban;
  const confirmed =
    history.data?.items.some((item) => ['SUCCEEDED', 'USER_CONFIRMED'].includes(item.status)) ||
    (removal && ['SUCCEEDED', 'USER_CONFIRMED'].includes(removal.status));
  const inProgress = removal?.status === 'DISPATCHED';
  const unknown = history.data?.items.some((item) => item.status === 'UNKNOWN');
  const mutation = useMutation({
    mutationFn: (intent: UnbanRequest) => requestUnban(target, intent),
    retry: false,
    onSuccess: ({ removal: result }) => {
      if (!mounted.current) return;
      client.setQueryData(key, {
        items: [
          result,
          ...(history.data?.items ?? []).filter((item) => item.id !== result.id),
        ].slice(0, 50),
      });
      setRequest(null);
      setMethod(null);
      void client.invalidateQueries({
        queryKey: ['live-chat', scope.accountId, scope.channelId, scope.sessionId],
      });
      void client.invalidateQueries({
        queryKey: ['history-action-statistics', scope.accountId, scope.sessionId],
      });
    },
    onError: (error) => {
      if (!mounted.current) return;
      if (error instanceof ApiError && [401, 403].includes(error.status))
        void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      if (error instanceof ApiError && error.status > 0 && error.status < 500) {
        setRequest(null);
        void client.invalidateQueries({ queryKey: key });
      }
    },
  });

  async function submit() {
    if (!method || submitting.current) return;
    if (
      !request &&
      (history.isPending ||
        history.isError ||
        confirmed ||
        inProgress ||
        (method === 'YOUTUBE' && unknown))
    )
      return;
    submitting.current = true;
    // Keep the same request ID after a lost HTTP response. Never create an automatic retry.
    const intent =
      request ??
      (method === 'YOUTUBE'
        ? ({ request_id: crypto.randomUUID(), method } as const)
        : ({ request_id: crypto.randomUUID(), method, confirmed: true } as const));
    setRequest(intent);
    try {
      await mutation.mutateAsync(intent);
    } catch {
      /* The dialog keeps the result and replay action visible. */
    } finally {
      submitting.current = false;
    }
  }

  const disabled =
    history.isPending || history.isError || mutation.isPending || Boolean(confirmed || inProgress);
  return (
    <div role="group" aria-label="Unban viewer" className="space-y-2">
      <RemovalResult removal={removal} />
      {history.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          Checking unban history…
        </p>
      )}
      {history.isError && (
        <div>
          <p role="alert" className="text-xs">
            Unable to check unban history. {getErrorMessage(history.error)}
          </p>
          <Button size="sm" variant="outline" onClick={() => void history.refetch()}>
            Check again
          </Button>
        </div>
      )}
      {!confirmed && (
        <div className="flex flex-wrap gap-2">
          {request ? (
            <Button size="sm" variant="outline" onClick={() => setMethod(request.method)}>
              Review pending request
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || unknown}
                onClick={() => {
                  mutation.reset();
                  setMethod('YOUTUBE');
                }}
              >
                Unban viewer
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  mutation.reset();
                  setMethod('STUDIO_CONFIRMATION');
                }}
              >
                Already unbanned in YouTube Studio
              </Button>
            </>
          )}
        </div>
      )}
      <Dialog.Root
        open={method !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setMethod(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content
            onEscapeKeyDown={(event) => {
              if (mutation.isPending) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (mutation.isPending) event.preventDefault();
            }}
            className="fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-xl border bg-background p-6 shadow-lg"
          >
            <Dialog.Title className="text-lg font-semibold">
              {method === 'YOUTUBE' ? 'Unban this viewer?' : 'Confirm unban in YouTube Studio'}
            </Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">
              {method === 'YOUTUBE'
                ? 'Ask YouTube to remove the permanent ban recorded for this message. New messages may be moderated again. Deleted messages will not be restored.'
                : 'Only confirm after you have removed this viewer from Hidden users in YouTube Studio. This records your confirmation; it does not send an unban request or verify the current YouTube state.'}
            </Dialog.Description>
            {mutation.isError && (
              <p role="alert" className="text-sm text-destructive">
                {removalError(mutation.error)}{' '}
                {request &&
                  'The result may not have reached this page. Retry uses the same request ID and will not repeat an already recorded request.'}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="outline" disabled={mutation.isPending}>
                  Close
                </Button>
              </Dialog.Close>
              <Button
                disabled={
                  mutation.isPending ||
                  (!request && (disabled || (method === 'YOUTUBE' && unknown)))
                }
                onClick={() => void submit()}
              >
                {mutation.isPending
                  ? 'Submitting…'
                  : request
                    ? 'Retry same request'
                    : method === 'YOUTUBE'
                      ? 'Confirm unban'
                      : 'Confirm already unbanned'}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
