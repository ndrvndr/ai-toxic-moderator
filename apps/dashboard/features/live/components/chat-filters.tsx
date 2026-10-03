'use client';

import { category, chatOutcomeFilter } from '@moderator/contracts';

import { Button } from '@/components/ui/button';

import type { ChatFilters } from '../lib/chat-filters';

const outcomeLabels: Record<NonNullable<ChatFilters['outcome']>, string> = {
  ALLOW: 'Allowed',
  REVIEW: 'Review',
  ACTION_REQUIRED: 'Action required',
  ERROR: 'Evaluation error',
  NOT_EVALUATED: 'Not evaluated',
};

export function ChatFilterControls({
  filters,
  onChange,
}: {
  filters: ChatFilters;
  onChange: (filters: ChatFilters) => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Evaluation result</legend>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={!filters.outcome ? 'secondary' : 'outline'}
            aria-pressed={!filters.outcome}
            onClick={() => onChange({ ...filters, outcome: undefined })}
          >
            All results
          </Button>
          {chatOutcomeFilter.options.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={filters.outcome === value ? 'secondary' : 'outline'}
              aria-pressed={filters.outcome === value}
              onClick={() => onChange({ ...filters, outcome: value })}
            >
              {outcomeLabels[value]}
            </Button>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Primary category</legend>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={!filters.category ? 'secondary' : 'outline'}
            aria-pressed={!filters.category}
            onClick={() => onChange({ ...filters, category: undefined })}
          >
            All categories
          </Button>
          {category.options.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={filters.category === value ? 'secondary' : 'outline'}
              aria-pressed={filters.category === value}
              onClick={() => onChange({ ...filters, category: value })}
            >
              {value.replaceAll('_', ' ')}
            </Button>
          ))}
        </div>
      </fieldset>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!filters.outcome && !filters.category}
        onClick={() => onChange({})}
      >
        Clear chat filters
      </Button>
      <p className="text-xs text-muted-foreground">
        Filters apply together to each stored chat item's latest evaluation. Session statistics
        remain unfiltered. Not evaluated also includes moderation events without a classification.
      </p>
    </div>
  );
}
