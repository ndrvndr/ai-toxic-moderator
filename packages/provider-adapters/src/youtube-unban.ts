import { z } from 'zod';

const requestSchema = z.strictObject({
  accessToken: z.string().min(1).regex(/^\S+$/u),
  banId: z.string().min(1).max(1024).regex(/^\S+$/u),
});

export type YoutubeUnbanInput = z.infer<typeof requestSchema> & { signal?: AbortSignal };
export type YoutubeUnbanResult =
  | { status: 'SUCCEEDED'; http_status: 204 }
  | { status: 'NOT_SENT'; code: 'INVALID_REQUEST' | 'REQUEST_CANCELLED' }
  | {
      status: 'REJECTED';
      http_status: number;
      code:
        | 'INVALID_REQUEST'
        | 'RECONNECT_REQUIRED'
        | 'YOUTUBE_FORBIDDEN'
        | 'BAN_NOT_FOUND'
        | 'YOUTUBE_RATE_LIMITED';
    }
  | {
      status: 'UNKNOWN';
      http_status: number | null;
      code:
        | 'REQUEST_INTERRUPTED'
        | 'TRANSPORT_ERROR'
        | 'YOUTUBE_UNAVAILABLE'
        | 'UNEXPECTED_RESPONSE';
    };

/** One attempt only. A lost response must never trigger an automatic retry. */
export class YoutubeUnbanAdapter {
  constructor(private readonly transport: typeof fetch = fetch) {}

  async removeBan(input: YoutubeUnbanInput): Promise<YoutubeUnbanResult> {
    const { signal: requestedSignal, ...raw } = input;
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return { status: 'NOT_SENT', code: 'INVALID_REQUEST' };
    if (requestedSignal?.aborted) return { status: 'NOT_SENT', code: 'REQUEST_CANCELLED' };

    const timeout = AbortSignal.timeout(10000);
    const signal = requestedSignal ? AbortSignal.any([requestedSignal, timeout]) : timeout;
    const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/bans');
    url.searchParams.set('id', parsed.data.banId);
    let response: Response;
    try {
      response = await this.transport(url.toString(), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${parsed.data.accessToken}` },
        redirect: 'error',
        signal,
      });
    } catch {
      return {
        status: 'UNKNOWN',
        http_status: null,
        code: signal.aborted ? 'REQUEST_INTERRUPTED' : 'TRANSPORT_ERROR',
      };
    }

    // Do not parse or expose provider error bodies, or follow redirects.
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 204) return { status: 'SUCCEEDED', http_status: 204 };
    const rejected: Partial<
      Record<number, Extract<YoutubeUnbanResult, { status: 'REJECTED' }>['code']>
    > = {
      400: 'INVALID_REQUEST',
      401: 'RECONNECT_REQUIRED',
      403: 'YOUTUBE_FORBIDDEN',
      404: 'BAN_NOT_FOUND',
      429: 'YOUTUBE_RATE_LIMITED',
    };
    const code = rejected[response.status];
    if (code) return { status: 'REJECTED', http_status: response.status, code };
    return {
      status: 'UNKNOWN',
      http_status: response.status,
      code: response.status >= 500 ? 'YOUTUBE_UNAVAILABLE' : 'UNEXPECTED_RESPONSE',
    };
  }
}
