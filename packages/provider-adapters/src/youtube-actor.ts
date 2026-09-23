import { z } from 'zod';

const channelResponse = z.object({
  kind: z.literal('youtube#channelListResponse'),
  items: z.array(
    z.object({
      id: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
    }),
  ),
  nextPageToken: z.string().optional(),
  pageInfo: z
    .object({
      totalResults: z.number().int().nonnegative(),
    })
    .optional(),
});

export type YoutubeActorResult =
  | {
      status: 'RESOLVED';
      channelId: string;
    }
  | {
      status: 'UNRESOLVED';
      code:
        | 'INVALID_TOKEN'
        | 'REQUEST_CANCELLED'
        | 'HTTP_ERROR'
        | 'INVALID_RESPONSE'
        | 'AMBIGUOUS_IDENTITY'
        | 'TRANSPORT_ERROR';
      httpStatus: number | null;
    };

export class YoutubeActorAdapter {
  constructor(private readonly transport: typeof fetch = fetch) {}

  async resolve(accessToken: string, signal?: AbortSignal): Promise<YoutubeActorResult> {
    if (!accessToken || /\s/.test(accessToken)) {
      return {
        status: 'UNRESOLVED',
        code: 'INVALID_TOKEN',
        httpStatus: null,
      };
    }

    if (signal?.aborted) {
      return {
        status: 'UNRESOLVED',
        code: 'REQUEST_CANCELLED',
        httpStatus: null,
      };
    }

    const timeout = AbortSignal.timeout(10_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const url = new URL('https://www.googleapis.com/youtube/v3/channels');
    url.search = new URLSearchParams({
      part: 'id',
      mine: 'true',
      maxResults: '2',
    }).toString();

    let httpStatus: number | null = null;

    try {
      const response = await this.transport(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: requestSignal,
      });

      httpStatus = response.status;

      if (response.status !== 200) {
        return {
          status: 'UNRESOLVED',
          code: 'HTTP_ERROR',
          httpStatus,
        };
      }

      let body: unknown;

      try {
        body = await response.json();
      } catch {
        return {
          status: 'UNRESOLVED',
          code: signal?.aborted ? 'REQUEST_CANCELLED' : 'INVALID_RESPONSE',
          httpStatus,
        };
      }

      if (requestSignal.aborted) {
        return {
          status: 'UNRESOLVED',
          code: signal?.aborted ? 'REQUEST_CANCELLED' : 'TRANSPORT_ERROR',
          httpStatus,
        };
      }

      const parsed = channelResponse.safeParse(body);

      if (!parsed.success) {
        return {
          status: 'UNRESOLVED',
          code: 'INVALID_RESPONSE',
          httpStatus,
        };
      }

      const data = parsed.data;

      if (
        data.items.length !== 1 ||
        Boolean(data.nextPageToken) ||
        (data.pageInfo !== undefined && data.pageInfo.totalResults !== 1)
      ) {
        return {
          status: 'UNRESOLVED',
          code: 'AMBIGUOUS_IDENTITY',
          httpStatus,
        };
      }

      const channel = data.items[0];

      if (!channel) {
        return {
          status: 'UNRESOLVED',
          code: 'AMBIGUOUS_IDENTITY',
          httpStatus,
        };
      }

      return {
        status: 'RESOLVED',
        channelId: channel.id,
      };
    } catch {
      return {
        status: 'UNRESOLVED',
        code: signal?.aborted ? 'REQUEST_CANCELLED' : 'TRANSPORT_ERROR',
        httpStatus,
      };
    }
  }
}
