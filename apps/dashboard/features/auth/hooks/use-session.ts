'use client';

import { useQuery } from '@tanstack/react-query';

import { isTemporaryApiError } from '@/lib/api-client';

import { getSession } from '../api/auth-api';

export const SESSION_QUERY_KEY = ['auth', 'session'] as const;

export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (isTemporaryApiError(query.state.error) ? 5000 : false),
    retry: false,
  });
}
