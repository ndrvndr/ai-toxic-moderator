'use client';

import type { SavedSession } from '@moderator/contracts';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const statusOptions = [
  { value: '', label: 'All statuses' },
  { value: 'STARTING', label: 'Starting' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'STOPPING', label: 'Stopping' },
  { value: 'STOPPED', label: 'Stopped' },
  { value: 'FAILED', label: 'Failed' },
] as const satisfies ReadonlyArray<{
  value: '' | NonNullable<SavedSession['latest_status']>;
  label: string;
}>;

type HistorySearchFormProps = {
  search: string;
  status: string;
};

export function HistorySearchForm({ search, status }: HistorySearchFormProps) {
  const router = useRouter();
  const inputId = useId();
  const [value, setValue] = useState(search);
  const [selectedStatus, setSelectedStatus] = useState(status);
  const [isPending, startTransition] = useTransition();

  function navigate(q: string, nextStatus: string) {
    const query = new URLSearchParams();

    if (q) query.set('q', q);
    if (nextStatus) query.set('status', nextStatus);

    const suffix = query.toString();

    startTransition(() => {
      router.push(suffix ? `/history?${suffix}` : '/history');
    });
  }

  return (
    <form
      role="search"
      aria-label="Search livestream history"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        navigate(value.trim(), selectedStatus);
      }}
    >
      <div className="space-y-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          Livestream title
        </label>

        <Input
          id={inputId}
          name="q"
          type="search"
          value={value}
          maxLength={100}
          placeholder="Search saved livestreams"
          disabled={isPending}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>

      <fieldset disabled={isPending} className="space-y-2">
        <legend className="text-sm font-medium">Monitoring status</legend>

        <div className="flex flex-wrap gap-2">
          {statusOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={selectedStatus === option.value ? 'secondary' : 'outline'}
              aria-pressed={selectedStatus === option.value}
              onClick={() => setSelectedStatus(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Applying…' : 'Apply filters'}
        </Button>

        <Button
          type="button"
          variant="outline"
          disabled={isPending || (!value && !search && !selectedStatus && !status)}
          onClick={() => {
            setValue('');
            setSelectedStatus('');
            navigate('', '');
          }}
        >
          Clear filters
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Filter accessible saved sessions by title and latest monitoring status. Select Apply filters
        to update the results.
      </p>
    </form>
  );
}
