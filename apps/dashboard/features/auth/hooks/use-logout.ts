'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

import { logoutSession } from '../api/auth-api';
import { SESSION_QUERY_KEY } from './use-session';

export function useLogout() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: logoutSession,
    onSuccess: async () => {
      await queryClient.cancelQueries();

      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'auth',
      });

      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      router.replace('/login');
    },
  });
}
