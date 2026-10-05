'use client';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import {
  aiModerationSettingsConfiguration,
  type AiModerationSettingsRecord,
} from '@moderator/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  isAiSettingsAccessError,
  useSaveAiModerationSettings,
} from '../hooks/use-ai-moderation-settings';
import { aiModerationDraftInput, toAiModerationDraft } from '../lib/ai-moderation-draft';
import { AiModerationTier } from './ai-moderation-tier';

export function AiModerationSettingsForm({
  accountId,
  channelId,
  canEdit,
  initial,
  onReload,
}: {
  accountId: string;
  channelId: string;
  canEdit: boolean;
  initial: AiModerationSettingsRecord | null;
  onReload: () => Promise<AiModerationSettingsRecord | null>;
}) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => toAiModerationDraft(initial?.configuration));
  const [notice, setNotice] = useState('');
  const [validation, setValidation] = useState('');
  const [reloading, setReloading] = useState(false);
  const submitting = useRef(false);
  const validationNotice = useRef<HTMLParagraphElement>(null);
  const mutation = useSaveAiModerationSettings(accountId, channelId);
  const busy = mutation.isPending || reloading;
  const blocked = mutation.isError;
  const dirty =
    !saved || JSON.stringify(draft) !== JSON.stringify(toAiModerationDraft(saved.configuration));
  const editable = canEdit && !busy && !blocked;

  useEffect(() => {
    if (validation) validationNotice.current?.focus();
  }, [validation]);

  async function reload() {
    if (busy || submitting.current) return;
    setReloading(true);
    setValidation('');
    setNotice('');
    try {
      const record = await onReload();
      setSaved(record);
      setDraft(toAiModerationDraft(record?.configuration));
      mutation.reset();
      setNotice('Latest AI settings loaded. Unsaved changes were discarded.');
    } catch {
      setValidation('Unable to reload AI settings. Check your access and try again.');
    } finally {
      setReloading(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || !dirty || submitting.current) return;
    setValidation('');
    setNotice('');
    const parsed = aiModerationSettingsConfiguration.safeParse(aiModerationDraftInput(draft));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setValidation(
        `Check ${issue?.path.join('.') ?? 'configuration'}: ${issue?.message ?? 'Invalid AI settings.'}`,
      );
      validationNotice.current?.focus();
      return;
    }
    submitting.current = true;
    try {
      const record = await mutation.mutateAsync({
        expected_revision: saved?.revision ?? 0,
        configuration: parsed.data,
      });
      setSaved(record);
      setDraft(toAiModerationDraft(record.configuration));
      setNotice(`AI settings revision ${record.revision} saved.`);
    } catch {
      // A lost response may still have committed. Require explicit reload before another write.
    } finally {
      submitting.current = false;
    }
  }

  if (isAiSettingsAccessError(mutation.error))
    return (
      <p role="alert">
        AI settings access changed. Sign in and reload this page to verify your permissions.
      </p>
    );

  return (
    <form onSubmit={save} noValidate className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Saved AI revision: {saved?.revision ?? 'none'}.
      </p>
      {!saved && (
        <p className="text-sm text-muted-foreground">
          No AI settings saved yet. Complete the one-time model setup and choose your action limits
          before saving.
        </p>
      )}
      {!saved && (
        <p className="text-sm text-muted-foreground">
          AI, Delete, Timeout, and Ban start selected. They take effect only after you save valid
          settings and start a new monitoring session with the required worker features enabled. You
          can switch off any action before saving.
        </p>
      )}
      {!canEdit && <p role="status">Only the channel owner can change AI settings.</p>}
      <fieldset disabled={!editable} className="space-y-4">
        <legend className="sr-only">AI moderation configuration</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.automatic_actions_enabled}
            onChange={(event) =>
              setDraft({ ...draft, automatic_actions_enabled: event.target.checked })
            }
          />
          Allow AI to take action in new sessions
        </label>
        <p className="text-sm text-muted-foreground">
          AI gives each message a severity score from 0 to 1. It is not a probability of a policy
          violation. Lower limits let AI act on more messages. If several enabled limits are met,
          the strongest action is selected. Keep Delete below Timeout and Timeout below Ban,
          including actions you switch off.
        </p>
        <p className="text-sm text-muted-foreground">
          AI can misread context and act on harmless messages. A higher limit reduces how often an
          action is selected, but can also miss harmful messages. A ban can hide a viewer until you
          remove the restriction in YouTube.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <AiModerationTier
            name="Delete"
            value={draft.delete}
            onChange={(value) => setDraft({ ...draft, delete: value })}
          />
          <AiModerationTier
            name="Timeout"
            value={draft.timeout}
            duration={draft.timeout.duration_seconds}
            onChange={(value) => setDraft({ ...draft, timeout: { ...draft.timeout, ...value } })}
            onDurationChange={(value) =>
              setDraft({ ...draft, timeout: { ...draft.timeout, duration_seconds: value } })
            }
          />
          <AiModerationTier
            name="Ban"
            value={draft.ban}
            onChange={(value) => setDraft({ ...draft, ban: value })}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Model variant: <span className="font-medium text-foreground">INT8</span>. This is the
          version supported by the app; there is no variant to select.
        </p>
        <details open={!saved} className="space-y-3 rounded-lg border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            AI model setup · Advanced
          </summary>
          <p className="text-xs text-muted-foreground">
            One-time setup: these values must match the model used by the app. The revision is a
            40-character identifier, not a file path. Review your action limits whenever you change
            the model.
          </p>
          {(
            [
              ['model_id', 'AI model ID'],
              ['model_revision', 'AI model revision'],
              ['adapter_version', 'AI adapter version'],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="block space-y-1 text-sm">
              <span>{label}</span>
              <input
                type="text"
                value={draft.model[field]}
                spellCheck={false}
                maxLength={field === 'model_id' ? 200 : field === 'model_revision' ? 40 : 128}
                onChange={(event) =>
                  setDraft({ ...draft, model: { ...draft.model, [field]: event.target.value } })
                }
                className="h-10 w-full rounded-md border bg-background px-3"
              />
            </label>
          ))}
          <p className="text-xs text-muted-foreground">Score: expected severity</p>
        </details>
      </fieldset>
      {validation && (
        <p ref={validationNotice} role="alert" tabIndex={-1} className="text-sm text-destructive">
          {validation}
        </p>
      )}
      {blocked && (
        <p role="alert" className="text-sm text-destructive">
          {mutation.error instanceof ApiError && mutation.error.status === 409
            ? 'Another change was saved. Reload the latest AI settings before saving again.'
            : 'The save could not be confirmed. Reload AI settings before saving again.'}{' '}
          Your draft has been retained.
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {canEdit && (
          <Button type="submit" disabled={!editable || !dirty}>
            Save AI settings
          </Button>
        )}
        <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>
          Reload AI settings and discard changes
        </Button>
      </div>
    </form>
  );
}
