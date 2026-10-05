import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Trash2 } from 'lucide-react';
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
    <fieldset className="grid items-start gap-3 border-b py-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_auto]">
      <legend className="sr-only">Blacklist entry {number}</legend>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <Label htmlFor={`${id}-pattern`}>
            <span aria-hidden="true">Blocked text</span>
            <span className="sr-only">Blocked text for entry {number}</span>
          </Label>
          <Label className="flex items-center gap-1.5 text-muted-foreground">
            <Checkbox
              aria-label={`Entry ${number} enabled`}
              checked={entry.enabled}
              onCheckedChange={(checked) => onChange({ ...entry, enabled: checked === true })}
            />
            <span className="sr-only">Entry {number} enabled</span>
            <span aria-hidden="true">Enabled</span>
          </Label>
        </div>
        <Input
          aria-label={`Blocked text for entry ${number}`}
          id={`${id}-pattern`}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          maxLength={253}
          value={entry.pattern}
          aria-describedby={`${id}-help`}
          onChange={(e) => onChange({ ...entry, pattern: e.target.value })}
        />
        <p id={`${id}-help`} className="sr-only">
          {entry.match_type === 'DOMAIN'
            ? 'Enter a domain such as example.com without a URL scheme, path, or wildcard.'
            : entry.match_type === 'WORD'
              ? 'Enter one word without spaces or punctuation.'
              : 'Enter the phrase you want to block. Symbols are matched as ordinary text.'}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-type`} className="block text-xs">
          <span aria-hidden="true">Match</span>
          <span className="sr-only">Match type for entry {number}</span>
        </Label>
        <NativeSelect
          aria-label={`Match type for entry ${number}`}
          id={`${id}-type`}
          className="h-10 w-full rounded-md border bg-background px-2 text-sm"
          value={entry.match_type}
          onChange={(e) =>
            onChange({ ...entry, match_type: e.target.value as BlacklistEntryDraft['match_type'] })
          }
        >
          <option value="WORD">Word</option>
          <option value="PHRASE">Phrase</option>
          <option value="DOMAIN">Domain</option>
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-action`} className="block text-xs">
          <span aria-hidden="true">Action</span>
          <span className="sr-only">Action for entry {number}</span>
        </Label>
        <NativeSelect
          aria-label={`Action for entry ${number}`}
          id={`${id}-action`}
          className="h-10 w-full rounded-md border bg-background px-2 text-sm"
          value={entry.action}
          onChange={(e) =>
            onChange({ ...entry, action: e.target.value as BlacklistEntryDraft['action'] })
          }
        >
          <option value="DELETE">Delete message</option>
          <option value="DELETE_TIMEOUT">Delete and time out viewer</option>
          <option value="DELETE_BAN">Delete and ban viewer</option>
        </NativeSelect>
        {entry.action === 'DELETE_TIMEOUT' && (
          <Label className="flex items-center gap-2 text-xs" htmlFor={`${id}-duration`}>
            <span aria-hidden="true">Seconds</span>
            <span className="sr-only">Timeout seconds for entry {number}</span>
            <Input
              aria-label={`Timeout seconds for entry ${number}`}
              id={`${id}-duration`}
              type="number"
              min={1}
              max={86400}
              step={1}
              className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
              value={entry.duration_seconds}
              onChange={(e) => onChange({ ...entry, duration_seconds: e.target.value })}
            />
          </Label>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="lg:mt-6"
        aria-label={`Remove entry ${number}`}
        onClick={onRemove}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>
    </fieldset>
  );
}
