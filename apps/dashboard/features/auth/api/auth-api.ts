import type { z } from 'zod';

import { ApiError, apiRequest } from '@/lib/api-client';
import { meResponse } from '@moderator/contracts';

export type Session = z.infer<typeof meResponse>;

export async function getSession(signal?: AbortSignal): Promise<Session | null> {
  try {
    return meResponse.parse(await apiRequest('/v1/me', { signal }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }

    throw error;
  }
}

export async function logoutSession(): Promise<void> {
  try {
    await apiRequest('/v1/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    throw error;
  }
}
