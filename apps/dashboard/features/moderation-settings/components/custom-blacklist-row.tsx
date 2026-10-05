import { Button } from '@/components/ui/button';
import type { BlacklistEntryDraft } from '../lib/blacklist-draft';

export function CustomBlacklistRow({
  entry,
  index,
  onChange,
  onRemove,
}: {
  entry: BlacklistEntryDraft;
  index: number;
  onChange: (entry: BlacklistEntryDraft) => void;
  onRemove: () => void;
}) {
  const number = index + 1;
  const id = `blacklist-${entry.id}`;
  return (
    <fieldset className="space-y-3 rounded-xl border bg-muted/20 p-4">
      <legend className="px-1 text-sm font-medium">Blacklist entry {number}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={(e) => onChange({ ...entry, enabled: e.target.checked })}
        />
        Entry {number} enabled
      </label>
      <label htmlFor={`${id}-type`} className="block text-sm">
        Match type for entry {number}
      </label>
      <select
        id={`${id}-type`}
        className="w-full rounded-md border bg-background p-2"
        value={entry.match_type}
        onChange={(e) =>
          onChange({ ...entry, match_type: e.target.value as BlacklistEntryDraft['match_type'] })
        }
      >
        <option value="WORD">Word</option>
        <option value="PHRASE">Phrase</option>
        <option value="DOMAIN">Domain</option>
      </select>
      <label htmlFor={`${id}-pattern`} className="block text-sm">
        Blocked text for entry {number}
      </label>
      <input
        id={`${id}-pattern`}
        className="w-full rounded-md border bg-background p-2"
        maxLength={253}
        value={entry.pattern}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange({ ...entry, pattern: e.target.value })}
      />
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        {entry.match_type === 'DOMAIN'
          ? 'Enter a domain such as example.com without a URL scheme, path, or wildcard.'
          : entry.match_type === 'WORD'
            ? 'Enter one word without spaces or punctuation.'
            : 'Enter the phrase you want to block. Symbols are matched as ordinary text.'}
      </p>
      <label htmlFor={`${id}-action`} className="block text-sm">
        Action for entry {number}
      </label>
      <select
        id={`${id}-action`}
        className="w-full rounded-md border bg-background p-2"
        value={entry.action}
        onChange={(e) =>
          onChange({ ...entry, action: e.target.value as BlacklistEntryDraft['action'] })
        }
      >
        <option value="DELETE">Delete message</option>
        <option value="DELETE_TIMEOUT">Delete and time out viewer</option>
        <option value="DELETE_BAN">Delete and ban viewer</option>
      </select>
      {entry.action === 'DELETE_TIMEOUT' && (
        <>
          <label htmlFor={`${id}-duration`} className="block text-sm">
            Timeout seconds for entry {number}
          </label>
          <input
            id={`${id}-duration`}
            type="number"
            min={1}
            max={86400}
            step={1}
            className="w-full rounded-md border bg-background p-2"
            value={entry.duration_seconds}
            onChange={(e) => onChange({ ...entry, duration_seconds: e.target.value })}
          />
        </>
      )}
      <Button type="button" variant="outline" onClick={onRemove}>
        Remove entry {number}
      </Button>
    </fieldset>
  );
}
