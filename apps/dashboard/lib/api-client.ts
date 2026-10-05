import { z } from 'zod';

export const API_ORIGIN = (process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3001').replace(
  /\/$/,
  '',
);

export const GOOGLE_LOGIN_URL = `${API_ORIGIN}/v1/auth/google`;

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
  }),
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export function isTemporaryApiError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

export async function apiRequest(path: string, options: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(options.headers);

  if (options.body) {
    headers.set('Content-Type', 'application/json');
  }

  const timeout = AbortSignal.timeout(15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;

  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      ...options,
      headers,
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(0, 'NETWORK_ERROR');
  }

  if (response.status === 204) return null;

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = errorEnvelope.safeParse(body);

    throw new ApiError(response.status, parsed.success ? parsed.data.error.code : 'REQUEST_FAILED');
  }

  return body;
}

export function getErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The server returned an unexpected response. Please try again.';
  }

  switch (error.code) {
    case 'NETWORK_ERROR':
      return 'The server could not be reached or took too long to respond.';
    case 'RECONNECT_REQUIRED':
      return 'Your Google connection has expired. Please reconnect your account.';
    case 'YOUTUBE_FORBIDDEN':
      return 'YouTube denied access. Check your account permissions and API configuration.';
    case 'GOOGLE_AUTH_DISABLED':
      return 'Google authentication is not enabled on the server.';
    case 'GOOGLE_UNAVAILABLE':
      return 'Google is currently unavailable. Please try again.';
    default:
      return 'The request could not be completed. Please try again.';
  }
}
