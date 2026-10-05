'use client';

import { Button } from '@/components/ui/button';
import { SESSION_QUERY_KEY } from '@/features/auth/hooks/use-session';
import { apiRequest, getErrorMessage, GOOGLE_LOGIN_URL } from '@/lib/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';

export function ChannelSetup() {
  const client = useQueryClient();
  const [empty, setEmpty] = useState(false);
  const setup = useMutation({
    mutationFn: async () =>
      z
        .strictObject({ channel_count: z.number().int().nonnegative() })
        .parse(await apiRequest('/v1/youtube/channels/sync', { method: 'POST', body: '{}' })),
    retry: false,
    onSuccess: async (result) => {
      setEmpty(result.channel_count === 0);
      await client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
  return (
    <div className="space-y-3 rounded-xl border border-dashed p-5">
      <h2 className="font-medium">Connect your YouTube channel</h2>
      <p className="text-sm text-muted-foreground">
        Load the channel from your connected Google account to set up moderation. You don’t need to
        start a livestream.
      </p>
      <Button disabled={setup.isPending} onClick={() => setup.mutate()}>
        {setup.isPending ? 'Loading channel…' : 'Load my channel'}
      </Button>
      {empty && (
        <p role="status" className="text-sm text-muted-foreground">
          No YouTube channel was found for this account. Connect the Google account you use for
          streaming.
        </p>
      )}
      {setup.isError && (
        <p role="alert" className="text-sm text-destructive">
          {getErrorMessage(setup.error)}
        </p>
      )}
      <p className="text-sm">
        <a className="underline underline-offset-4" href={GOOGLE_LOGIN_URL}>
          Connect another Google account
        </a>
      </p>
    </div>
  );
}
