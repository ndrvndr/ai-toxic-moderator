import { youtubeChatListResponse } from '@moderator/contracts';

export type YoutubeChatErrorCode =
  | 'INVALID_REQUEST'
  | 'REQUEST_CANCELLED'
  | 'RECONNECT_REQUIRED'
  | 'YOUTUBE_UNAVAILABLE'
  | 'YOUTUBE_FORBIDDEN'
  | 'YOUTUBE_QUOTA_EXCEEDED'
  | 'YOUTUBE_RATE_LIMITED'
  | 'LIVE_CHAT_DISABLED'
  | 'LIVE_CHAT_ENDED'
  | 'LIVE_CHAT_NOT_FOUND'
  | 'INVALID_PAGE_TOKEN'
  | 'INVALID_PROVIDER_RESPONSE';

export class YoutubeChatError extends Error {
  constructor(
    readonly code: YoutubeChatErrorCode,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = 'YoutubeChatError';
  }
}

type ListChatInput = {
  accessToken: string;
  liveChatId: string;
  pageToken: string | null;
  signal?: AbortSignal;
};

function errorReasons(body: unknown): string[] {
  if (body === null || typeof body !== 'object' || !('error' in body)) {
    return [];
  }

  const error = body.error;

  if (error === null || typeof error !== 'object' || !('errors' in error)) {
    return [];
  }

  if (!Array.isArray(error.errors)) return [];

  return error.errors.flatMap((entry: unknown) => {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      'reason' in entry &&
      typeof entry.reason === 'string'
    ) {
      return [entry.reason];
    }

    return [];
  });
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;

  const value = header.trim();
  const duration = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();

  if (!Number.isFinite(duration)) return null;

  const result = Math.max(0, Math.ceil(duration));
  return Number.isSafeInteger(result) ? result : null;
}

function responseError(response: Response, body: unknown): YoutubeChatError {
  const reasons = errorReasons(body);
  const retry = retryAfterMs(response.headers.get('retry-after'));

  if (response.status === 401) {
    return new YoutubeChatError('RECONNECT_REQUIRED');
  }

  if (response.status >= 500) {
    return new YoutubeChatError('YOUTUBE_UNAVAILABLE', retry);
  }

  if (
    response.status === 429 ||
    reasons.some((reason) => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason))
  ) {
    return new YoutubeChatError('YOUTUBE_RATE_LIMITED', retry);
  }

  if (reasons.some((reason) => ['quotaExceeded', 'dailyLimitExceeded'].includes(reason))) {
    return new YoutubeChatError('YOUTUBE_QUOTA_EXCEEDED', retry);
  }

  if (reasons.includes('liveChatEnded')) {
    return new YoutubeChatError('LIVE_CHAT_ENDED');
  }

  if (reasons.includes('liveChatDisabled')) {
    return new YoutubeChatError('LIVE_CHAT_DISABLED');
  }

  if (reasons.includes('liveChatNotFound') || response.status === 404) {
    return new YoutubeChatError('LIVE_CHAT_NOT_FOUND');
  }

  if (reasons.includes('invalidPageToken')) {
    return new YoutubeChatError('INVALID_PAGE_TOKEN');
  }

  if (response.status === 403) {
    return new YoutubeChatError('YOUTUBE_FORBIDDEN');
  }

  return new YoutubeChatError('INVALID_PROVIDER_RESPONSE');
}

export class YoutubeChatAdapter {
  constructor(private readonly transport: typeof fetch = fetch) {}

  async list(input: ListChatInput) {
    if (
      !input.accessToken ||
      !input.liveChatId ||
      input.liveChatId.length > 1024 ||
      (input.pageToken !== null && input.pageToken.length === 0)
    ) {
      throw new YoutubeChatError('INVALID_REQUEST');
    }

    if (input.signal?.aborted) {
      throw new YoutubeChatError('REQUEST_CANCELLED');
    }

    const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages');

    url.search = new URLSearchParams({
      liveChatId: input.liveChatId,
      part: 'id,snippet,authorDetails',
      maxResults: '500',
    }).toString();

    if (input.pageToken !== null) {
      url.searchParams.set('pageToken', input.pageToken);
    }

    const timeout = AbortSignal.timeout(10000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

    let response: Response;
    let body: unknown;

    try {
      response = await this.transport(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal,
      });

      body = await response.json().catch(() => null);
    } catch {
      throw new YoutubeChatError(
        input.signal?.aborted ? 'REQUEST_CANCELLED' : 'YOUTUBE_UNAVAILABLE',
      );
    }

    if (input.signal?.aborted) {
      throw new YoutubeChatError('REQUEST_CANCELLED');
    }

    if (timeout.aborted) {
      throw new YoutubeChatError('YOUTUBE_UNAVAILABLE');
    }

    if (!response.ok) throw responseError(response, body);

    const parsed = youtubeChatListResponse.safeParse(body);

    if (!parsed.success) {
      throw new YoutubeChatError('INVALID_PROVIDER_RESPONSE');
    }

    const data = parsed.data;
    const items = data.activePollItem ? [...data.items, data.activePollItem] : data.items;

    if (items.some((item) => item.snippet.liveChatId !== input.liveChatId)) {
      throw new YoutubeChatError('INVALID_PROVIDER_RESPONSE');
    }

    return {
      next_page_token: data.nextPageToken ?? null,
      polling_interval_ms: Math.max(1, data.pollingIntervalMillis),
      offline_at: data.offlineAt ?? null,
      items,
    };
  }
}
