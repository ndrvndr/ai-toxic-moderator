'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function HistorySearchForm({ search }: { search: string }) {
  const router = useRouter();
  const inputId = useId();
  const [value, setValue] = useState(search);
  const [isPending, startTransition] = useTransition();

  function navigate(q: string) {
    const query = new URLSearchParams();

    if (q) {
      query.set('q', q);
    }

    startTransition(() => {
      router.push(q ? `/history?${query}` : '/history');
    });
  }

  return (
    <form
      role="search"
      aria-label="Search livestream history"
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        navigate(value.trim());
      }}
    >
      <label htmlFor={inputId} className="text-sm font-medium">
        Livestream title
      </label>

      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          name="q"
          type="search"
          value={value}
          maxLength={100}
          placeholder="Search saved livestreams"
          className="min-w-0 flex-1"
          onChange={(event) => setValue(event.target.value)}
        />

        <Button type="submit" disabled={isPending}>
          {isPending ? 'Searching…' : 'Search'}
        </Button>

        <Button
          type="button"
          variant="outline"
          disabled={isPending || (!value && !search)}
          onClick={() => {
            setValue('');
            navigate('');
          }}
        >
          Clear
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Search all accessible saved sessions by title.
      </p>
    </form>
  );
}
