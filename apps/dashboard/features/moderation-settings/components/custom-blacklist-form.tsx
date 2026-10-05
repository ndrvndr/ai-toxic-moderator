'use client';
import { Alert } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { customBlacklistConfiguration, type CustomBlacklistRecord } from '@moderator/contracts';
import { useRef, useState, type FormEvent } from 'react';
import { isBlacklistAccessError, useSaveCustomBlacklist } from '../hooks/use-custom-blacklist';
import { blacklistDraftInput, toBlacklistDraft } from '../lib/blacklist-draft';
import { CustomBlacklistRow } from './custom-blacklist-row';

export function CustomBlacklistForm({
  accountId,
  channelId,
  canEdit,
  initial,
  onReload,
}: {
  accountId: string;
  channelId: string;
  canEdit: boolean;
  initial: CustomBlacklistRecord | null;
  onReload: () => Promise<CustomBlacklistRecord | null>;
}) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => toBlacklistDraft(initial?.configuration));
  const [notice, setNotice] = useState('');
  const [validation, setValidation] = useState('');
  const [reloading, setReloading] = useState(false);
  const [search, setSearch] = useState('');
  const searchTerm = search.trim().toLowerCase();
  const visibleCount = draft.rules.filter((entry) =>
    entry.pattern.toLowerCase().includes(searchTerm),
  ).length;
  const submitting = useRef(false);
  const mutation = useSaveCustomBlacklist(accountId, channelId);
  const busy = mutation.isPending || reloading;
  const blocked = mutation.isError;
  const dirty = JSON.stringify(draft) !== JSON.stringify(toBlacklistDraft(saved?.configuration));
  const editable = canEdit && !busy && !blocked;

  async function reload() {
    if (busy || submitting.current) return;
    setReloading(true);
    setValidation('');
    setNotice('');
    try {
      const record = await onReload();
      setSaved(record);
      setDraft(toBlacklistDraft(record?.configuration));
      mutation.reset();
      setNotice('Latest blacklist loaded. Unsaved changes were discarded.');
    } catch {
      setValidation('Unable to reload the blacklist. Check your access and try again.');
    } finally {
      setReloading(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || !dirty || submitting.current) return;
    setValidation('');
    setNotice('');
    const parsed = customBlacklistConfiguration.safeParse(blacklistDraftInput(draft));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const entry =
        issue?.path[0] === 'rules' && typeof issue.path[1] === 'number'
          ? `Entry ${issue.path[1] + 1}: `
          : '';
      setValidation(`${entry}${issue?.message ?? 'Check the blacklist configuration.'}`);
      return;
    }
    const input = { expected_revision: saved?.revision ?? 0, configuration: parsed.data };
    if (new Blob([JSON.stringify(input)]).size > 16 * 1024) {
      setValidation('The blacklist exceeds the 16 KB request limit. Shorten or remove entries.');
      return;
    }
    submitting.current = true;
    try {
      const record = await mutation.mutateAsync(input);
      setSaved(record);
      setDraft(toBlacklistDraft(record.configuration));
      setNotice(`Blacklist revision ${record.revision} saved.`);
    } catch {
      // Keep the draft until the owner explicitly reloads the stored revision.
    } finally {
      submitting.current = false;
    }
  }

  if (isBlacklistAccessError(mutation.error)) {
    return (
      <Alert role="alert">
        Blacklist access changed. Sign in and reload this page to verify your permissions.
      </Alert>
    );
  }

  return (
    <form onSubmit={save} noValidate className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Saved revision: {saved?.revision ?? 'none'}. Up to 100 entries.
      </p>
      {!canEdit && <p role="status">Only the channel owner can change the blacklist.</p>}
      {notice && <p role="status">{notice}</p>}
      {validation && <Alert role="alert">{validation}</Alert>}
      {blocked && (
        <Alert role="alert">
          {mutation.error instanceof ApiError && mutation.error.status === 409
            ? 'Another change was saved. Reload the latest blacklist before saving again.'
            : 'The save could not be confirmed. Reload the blacklist before saving again.'}{' '}
          Your draft has been retained.
        </Alert>
      )}
      <fieldset disabled={!editable} className="space-y-4">
        <legend className="sr-only">Blacklist configuration</legend>
        <Label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.enabled}
            onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked === true })}
          />
          Enable blocked words
        </Label>
        {draft.rules.length > 0 && (
          <div className="space-y-2">
            <Label htmlFor={`blacklist-search-${channelId}`} className="text-sm font-medium">
              Search blocked words
            </Label>
            <Input
              id={`blacklist-search-${channelId}`}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a word, phrase, or domain"
              className="h-10 w-full rounded-md border bg-background px-3"
            />
            <p className="text-xs text-muted-foreground">
              Showing {visibleCount} of {draft.rules.length} entries. Word matches a single word;
              Phrase matches text; Domain matches a website address.
            </p>
            {visibleCount === 0 && (
              <p className="text-sm text-muted-foreground">
                No matching entries. Try another search or clear it.
              </p>
            )}
            {search && (
              <Button type="button" variant="ghost" onClick={() => setSearch('')}>
                Clear search
              </Button>
            )}
          </div>
        )}
        <div className="max-h-[28rem] overflow-y-auto">
          {draft.rules.map((entry, index) => (
            <div key={entry.id} hidden={!entry.pattern.toLowerCase().includes(searchTerm)}>
              <CustomBlacklistRow
                entry={entry}
                index={index}
                onChange={(updated) => {
                  if (editable)
                    setDraft({
                      ...draft,
                      rules: draft.rules.map((rule) => (rule.id === entry.id ? updated : rule)),
                    });
                }}
                onRemove={() => {
                  if (editable)
                    setDraft({
                      ...draft,
                      rules: draft.rules.filter((rule) => rule.id !== entry.id),
                    });
                }}
              />
            </div>
          ))}
        </div>
        {draft.rules.length === 0 && (
          <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
            Your list is empty. Add a word, phrase, or website domain to get started.
          </p>
        )}
        {canEdit && (
          <Button
            type="button"
            variant="outline"
            disabled={draft.rules.length >= 100}
            onClick={() => {
              setSearch('');
              if (editable && draft.rules.length < 100)
                setDraft({
                  ...draft,
                  rules: [
                    ...draft.rules,
                    {
                      id: crypto.randomUUID(),
                      enabled: true,
                      match_type: 'WORD',
                      pattern: '',
                      action: 'DELETE',
                      duration_seconds: '300',
                    },
                  ],
                });
            }}
          >
            Add blocked word
          </Button>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-3">
        {canEdit && (
          <Button type="submit" disabled={!editable || !dirty}>
            Save blocked words
          </Button>
        )}
        <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>
          Reload blacklist and discard changes
        </Button>
      </div>
    </form>
  );
}
