'use client';

import type { AiTierDraft } from '../lib/ai-moderation-draft';

export function AiModerationTier({
  name,
  value,
  duration,
  onChange,
  onDurationChange,
}: {
  name: 'Delete' | 'Timeout' | 'Ban';
  value: AiTierDraft;
  duration?: string;
  onChange: (value: AiTierDraft) => void;
  onDurationChange?: (value: string) => void;
}) {
  return (
    <fieldset className="space-y-3 rounded-xl border bg-muted/20 p-4">
      <legend className="px-1 text-sm font-medium">{name}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        Allow AI {name.toLowerCase()}
      </label>
      <label className="block space-y-1 text-sm">
        <span>{name} threshold</span>
        <input
          type="number"
          min="0"
          max="1"
          step="0.01"
          value={value.threshold}
          onChange={(event) => onChange({ ...value, threshold: event.target.value })}
          className="h-10 w-full rounded-md border bg-background px-3"
        />
      </label>
      {name === 'Timeout' && (
        <label className="block space-y-1 text-sm">
          <span>AI timeout seconds</span>
          <input
            type="number"
            min="1"
            max="86400"
            step="1"
            value={duration ?? ''}
            onChange={(event) => onDurationChange?.(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3"
          />
        </label>
      )}
      <p className="text-xs text-muted-foreground">
        {name === 'Delete'
          ? 'Remove the message from YouTube chat.'
          : name === 'Timeout'
            ? 'Delete the message and temporarily stop the viewer from sending chat.'
            : 'Delete the message and hide the viewer from chat until you remove them from YouTube’s hidden users.'}
      </p>
    </fieldset>
  );
}
