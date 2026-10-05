'use client';

import {
  moderationSettingsConfiguration,
  type ModerationRuleCatalogEntry,
  type ModerationSettingsConfiguration,
  type ModerationSettingsRecord,
  type ModerationSettingsRule,
} from '@moderator/contracts';
import { useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { ApiError, getErrorMessage } from '@/lib/api-client';

import { useSaveModerationSettings } from '../hooks/use-moderation-settings';
import { ModerationRuleRow } from './moderation-rule-row';

type Props = {
  accountId: string;
  channelId: string;
  canEdit: boolean;
  settings: ModerationSettingsRecord | null;
  catalog: ModerationRuleCatalogEntry[];
  onReload: () => Promise<ModerationSettingsRecord | null>;
};

const emptyConfiguration: ModerationSettingsConfiguration = {
  schema_version: 1,
  automatic_actions_enabled: false,
  rules: [],
};

export function ModerationSettingsForm({
  accountId,
  channelId,
  canEdit,
  settings,
  catalog,
  onReload,
}: Props) {
  const [draft, setDraft] = useState(settings?.configuration ?? emptyConfiguration);
  const [saved, setSaved] = useState(settings);
  const [reloading, setReloading] = useState(false);
  const [notice, setNotice] = useState('');
  const [validation, setValidation] = useState('');
  const mutation = useSaveModerationSettings(accountId, channelId);
  const submitting = useRef(false);
  const busy = mutation.isPending || reloading;
  // Any uncertain or rejected save requires an explicit reload before resubmission.
  const blocked = mutation.isError;
  const dirty = !saved || JSON.stringify(draft) !== JSON.stringify(saved.configuration);
  const unavailable = draft.rules.filter(
    (configured) =>
      !catalog.some(
        (entry) =>
          entry.rule_id === configured.rule_id &&
          entry.rule_version === configured.rule_version &&
          entry.strength === 'STRONG' &&
          entry.supported_actions.includes(configured.action),
      ),
  );

  function changeRule(ruleId: string, version: string, value?: ModerationSettingsRule) {
    setNotice('');
    setValidation('');
    setDraft((current) => ({
      ...current,
      rules: [
        ...current.rules.filter((rule) => rule.rule_id !== ruleId || rule.rule_version !== version),
        ...(value ? [value] : []),
      ],
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || busy || blocked || !dirty || submitting.current) return;
    const parsed = moderationSettingsConfiguration.safeParse(draft);
    if (!parsed.success || unavailable.length) {
      setValidation(
        'Check severity and timeout duration, and remove unsupported rule configurations.',
      );
      return;
    }
    setNotice('');
    setValidation('');
    submitting.current = true;
    try {
      const record = await mutation.mutateAsync({
        expected_revision: saved?.revision ?? 0,
        configuration: parsed.data,
      });
      setSaved(record);
      setDraft(record.configuration);
      setNotice(`Settings saved as revision ${record.revision}.`);
    } catch {
      // The mutation error is displayed below. Preserve the draft until explicit reload.
    } finally {
      submitting.current = false;
    }
  }

  async function reload() {
    if (busy) return;
    setReloading(true);
    setValidation('');
    setNotice('');
    try {
      const record = await onReload();
      mutation.reset();
      setSaved(record);
      setDraft(record?.configuration ?? emptyConfiguration);
      setNotice('Saved settings reloaded. Unsaved changes were discarded.');
    } catch (error) {
      setValidation(getErrorMessage(error));
    } finally {
      setReloading(false);
    }
  }

  const errorMessage =
    mutation.error instanceof ApiError && mutation.error.status === 409
      ? 'Settings changed elsewhere. Reload saved settings before editing again.'
      : mutation.error instanceof ApiError && [401, 403].includes(mutation.error.status)
        ? 'Your session or access permissions changed. Reload to check your access.'
        : mutation.error instanceof ApiError && mutation.error.status === 422
          ? 'Settings validation failed. Reload and check the selected rules and values.'
          : 'The save could not be confirmed. Reload saved settings before trying again.';

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {saved ? `Saved revision ${saved.revision}` : 'No settings saved yet'}
        </p>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>
          {reloading ? 'Reloading…' : 'Reload saved settings'}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Reloading discards unsaved changes.</p>
      {!canEdit && (
        <p role="status" className="rounded-lg border p-4 text-sm">
          Read-only access. Only the channel owner can change these settings.
        </p>
      )}
      <fieldset disabled={!canEdit || busy || blocked} className="space-y-5">
        <legend className="sr-only">Moderation configuration</legend>
        <label className="flex items-center gap-3 rounded-lg border p-4 text-sm font-medium">
          <input
            type="checkbox"
            checked={draft.automatic_actions_enabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              setNotice('');
              setDraft((current) => ({ ...current, automatic_actions_enabled: enabled }));
            }}
          />
          Allow built-in rules to take action
        </label>
        <p className="text-sm text-muted-foreground">
          Switching this off keeps your rules saved but stops them from selecting automatic actions.
          Rule checks still run. Blocked words and AI have their own switches.
        </p>
        {catalog.map((rule) => (
          <ModerationRuleRow
            key={`${rule.rule_id}:${rule.rule_version}`}
            rule={rule}
            configured={draft.rules.find(
              (entry) => entry.rule_id === rule.rule_id && entry.rule_version === rule.rule_version,
            )}
            onChange={(value) => changeRule(rule.rule_id, rule.rule_version, value)}
          />
        ))}
        {catalog.length === 0 && (
          <p className="text-sm text-muted-foreground">No configurable rules are available.</p>
        )}
        {unavailable.length > 0 && (
          <div className="space-y-3 rounded-lg border p-4">
            <h3 className="font-medium">Unavailable rule configurations</h3>
            {unavailable.map((rule) => (
              <div
                key={`${rule.rule_id}:${rule.rule_version}`}
                className="flex flex-wrap items-center gap-3"
              >
                <span className="break-all text-sm">
                  {rule.rule_id} · Version {rule.rule_version} · {rule.action}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => changeRule(rule.rule_id, rule.rule_version)}
                >
                  Remove configuration
                </Button>
              </div>
            ))}
          </div>
        )}
        {canEdit && (
          <Button type="submit" disabled={busy || blocked || !dirty || unavailable.length > 0}>
            {mutation.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        )}
      </fieldset>
      {validation && (
        <p role="alert" className="text-sm text-destructive">
          {validation}
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </form>
  );
}
