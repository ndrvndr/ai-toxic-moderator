export type YoutubeDeleteResult =
  | { status: 'SUCCEEDED'; http_status: 204 }
  | { status: 'NOT_SENT'; code: 'INVALID_REQUEST' | 'REQUEST_CANCELLED' }
  | {
      status: 'REJECTED';
      http_status: number;
      code:
        | 'RECONNECT_REQUIRED'
        | 'YOUTUBE_FORBIDDEN'
        | 'MESSAGE_NOT_FOUND'
        | 'YOUTUBE_RATE_LIMITED'
        | 'INVALID_REQUEST';
    }
  | {
      status: 'UNKNOWN';
      http_status: number | null;
      code:
        | 'TRANSPORT_ERROR'
        | 'REQUEST_INTERRUPTED'
        | 'YOUTUBE_UNAVAILABLE'
        | 'UNEXPECTED_RESPONSE';
    };

type DeleteMessageInput = {
  accessToken: string;
  externalMessageId: string;
  signal?: AbortSignal;
};

/** Single-attempt transport. The executor owns persistence and retry decisions. */
export class YoutubeModerationAdapter {
  constructor(private readonly transport: typeof fetch = fetch) {}

  async deleteMessage(input: DeleteMessageInput): Promise<YoutubeDeleteResult> {
    if (
      typeof input.accessToken !== 'string' ||
      !input.accessToken ||
      /\s/.test(input.accessToken) ||
      typeof input.externalMessageId !== 'string' ||
      !input.externalMessageId.trim() ||
      input.externalMessageId.length > 1024
    ) {
      return { status: 'NOT_SENT', code: 'INVALID_REQUEST' };
    }

    if (input.signal?.aborted) {
      return { status: 'NOT_SENT', code: 'REQUEST_CANCELLED' };
    }

    const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages');
    url.searchParams.set('id', input.externalMessageId);
    const timeout = AbortSignal.timeout(10000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.transport(url.toString(), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${input.accessToken}` },
        redirect: 'error',
        signal,
      });
    } catch {
      // Once dispatched, an interruption cannot prove whether deletion occurred.
      return {
        status: 'UNKNOWN',
        http_status: null,
        code: signal.aborted ? 'REQUEST_INTERRUPTED' : 'TRANSPORT_ERROR',
      };
    }

    // No response body is needed. Do not expose provider messages or credentials.
    void response.body?.cancel().catch(() => undefined);

    if (response.status === 204) {
      return { status: 'SUCCEEDED', http_status: 204 };
    }

    const rejected: Partial<
      Record<number, Extract<YoutubeDeleteResult, { status: 'REJECTED' }>['code']>
    > = {
      400: 'INVALID_REQUEST',
      401: 'RECONNECT_REQUIRED',
      403: 'YOUTUBE_FORBIDDEN',
      404: 'MESSAGE_NOT_FOUND',
      429: 'YOUTUBE_RATE_LIMITED',
    };
    const code = rejected[response.status];
    if (code) {
      return { status: 'REJECTED', http_status: response.status, code };
    }

    return {
      status: 'UNKNOWN',
      http_status: response.status,
      code: response.status >= 500 ? 'YOUTUBE_UNAVAILABLE' : 'UNEXPECTED_RESPONSE',
    };
  }
}
