import { z } from 'zod';

const identifier = z.string().min(1).max(1024).regex(/^\S+$/u);
const common = {
  accessToken: z.string().min(1).regex(/^\S+$/u),
  liveChatId: identifier,
  authorChannelId: identifier,
};
const requestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...common,
    action: z.literal('TIMEOUT'),
    durationSeconds: z.number().int().positive().safe(),
  }),
  z.strictObject({ ...common, action: z.literal('BAN') }),
]);
export type YoutubeBanInput = z.infer<typeof requestSchema> & { signal?: AbortSignal };

export type YoutubeBanResult =
  | { status: 'SUCCEEDED'; http_status: 200 | 201; ban_id: string }
  | { status: 'NOT_SENT'; code: 'INVALID_REQUEST' | 'REQUEST_CANCELLED' }
  | {
      status: 'REJECTED';
      http_status: number;
      code:
        | 'INVALID_REQUEST'
        | 'RECONNECT_REQUIRED'
        | 'YOUTUBE_FORBIDDEN'
        | 'CHAT_OR_USER_NOT_FOUND'
        | 'YOUTUBE_RATE_LIMITED';
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

const resourceSchema = z.object({
  kind: z.literal('youtube#liveChatBan'),
  id: identifier,
  snippet: z.object({
    liveChatId: identifier,
    type: z.enum(['temporary', 'permanent']),
    banDurationSeconds: z.number().int().positive().safe().optional(),
    bannedUserDetails: z.object({ channelId: identifier }),
  }),
});

/** One transport attempt only. No runtime scheduling or retry is performed here. */
export class YoutubeBanAdapter {
  constructor(private readonly transport: typeof fetch = fetch) {}

  async banUser(input: YoutubeBanInput): Promise<YoutubeBanResult> {
    const { signal: requestedSignal, ...raw } = input;
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return { status: 'NOT_SENT', code: 'INVALID_REQUEST' };
    if (requestedSignal?.aborted) return { status: 'NOT_SENT', code: 'REQUEST_CANCELLED' };
    const request = parsed.data;
    const type = request.action === 'TIMEOUT' ? 'temporary' : 'permanent';
    const timeout = AbortSignal.timeout(10000);
    const signal = requestedSignal ? AbortSignal.any([requestedSignal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.transport(
        'https://www.googleapis.com/youtube/v3/liveChat/bans?part=snippet',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${request.accessToken}`,
            'Content-Type': 'application/json',
          },
          redirect: 'error',
          signal,
          body: JSON.stringify({
            snippet: {
              liveChatId: request.liveChatId,
              type,
              bannedUserDetails: { channelId: request.authorChannelId },
              ...(request.action === 'TIMEOUT'
                ? { banDurationSeconds: request.durationSeconds }
                : {}),
            },
          }),
        },
      );
    } catch {
      return {
        status: 'UNKNOWN',
        http_status: null,
        code: signal.aborted ? 'REQUEST_INTERRUPTED' : 'TRANSPORT_ERROR',
      };
    }

    if (response.status === 200 || response.status === 201) {
      try {
        const resource = resourceSchema.safeParse(await response.json());
        if (
          resource.success &&
          resource.data.snippet.liveChatId === request.liveChatId &&
          resource.data.snippet.type === type &&
          resource.data.snippet.bannedUserDetails.channelId === request.authorChannelId &&
          (request.action !== 'TIMEOUT' ||
            resource.data.snippet.banDurationSeconds === request.durationSeconds)
        ) {
          return { status: 'SUCCEEDED', http_status: response.status, ban_id: resource.data.id };
        }
      } catch {
        return {
          status: 'UNKNOWN',
          http_status: response.status,
          code: signal.aborted ? 'REQUEST_INTERRUPTED' : 'UNEXPECTED_RESPONSE',
        };
      }
      return { status: 'UNKNOWN', http_status: response.status, code: 'UNEXPECTED_RESPONSE' };
    }

    void response.body?.cancel().catch(() => undefined);
    const rejected: Partial<
      Record<number, Extract<YoutubeBanResult, { status: 'REJECTED' }>['code']>
    > = {
      400: 'INVALID_REQUEST',
      401: 'RECONNECT_REQUIRED',
      403: 'YOUTUBE_FORBIDDEN',
      404: 'CHAT_OR_USER_NOT_FOUND',
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
