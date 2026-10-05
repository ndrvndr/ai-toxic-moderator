import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
export const GOOGLE_SCOPES = ['openid', 'profile', YOUTUBE_SCOPE];

export function encryptToken(value: string, key: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    content.toString('base64url'),
  ].join('.');
}

export function decryptToken(value: string, key: string, context: string): string {
  const [version, iv, tag, content, extra] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !content || extra !== undefined)
    throw new Error('Invalid encrypted token');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'hex'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(content, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export type GoogleProviderErrorCode =
  | 'RECONNECT_REQUIRED'
  | 'GOOGLE_UNAVAILABLE'
  | 'YOUTUBE_FORBIDDEN'
  | 'INVALID_BROADCAST_ID'
  | 'BROADCAST_NOT_FOUND'
  | 'BROADCAST_NOT_OWNED'
  | 'BROADCAST_NOT_LIVE'
  | 'LIVE_CHAT_UNAVAILABLE'
  | 'YOUTUBE_LOOKUP_INCOMPLETE';

export class GoogleProviderError extends Error {
  constructor(readonly code: GoogleProviderErrorCode) {
    super(code);
    this.name = 'GoogleProviderError';
  }
}

export type VerifiedBroadcast = Readonly<{
  youtube_broadcast_id: string;
  youtube_channel_id: string;
  channel_title: string;
  title: string;
  live_chat_id: string;
}>;

export type VerifiedYoutubeChannel = Readonly<{
  youtube_channel_id: string;
  channel_title: string;
}>;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.literal('Bearer'),
  scope: z.string().optional(),
});

export class GoogleProvider {
  constructor(private readonly transport: typeof fetch = fetch) {}

  private async json(url: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await this.transport(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new GoogleProviderError('GOOGLE_UNAVAILABLE');
    }
    if (!response.ok) {
      if (response.status === 401) throw new GoogleProviderError('RECONNECT_REQUIRED');
      if (response.status === 403) throw new GoogleProviderError('YOUTUBE_FORBIDDEN');
      if (response.status === 400 && url === 'https://oauth2.googleapis.com/token') {
        const body = await response.json().catch(() => null);
        if (body?.error === 'invalid_grant') throw new GoogleProviderError('RECONNECT_REQUIRED');
      }
      throw new GoogleProviderError('GOOGLE_UNAVAILABLE');
    }
    return response.json();
  }

  async token(params: Record<string, string>) {
    return tokenResponse.parse(
      await this.json('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      }),
    );
  }

  async profile(accessToken: string) {
    return z.object({ sub: z.string().min(1).max(255), name: z.string().min(1).max(200) }).parse(
      await this.json('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
  }

  async channels(accessToken: string): Promise<VerifiedYoutubeChannel[]> {
    const schema = z.object({
      items: z
        .array(
          z.object({
            id: z.string().min(1).max(128),
            snippet: z.object({ title: z.string().trim().min(1).max(200) }),
          }),
        )
        .default([]),
      nextPageToken: z.string().min(1).optional(),
    });
    const channels = new Map<string, VerifiedYoutubeChannel>();
    const visited = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL('https://www.googleapis.com/youtube/v3/channels');
      url.search = new URLSearchParams({
        part: 'id,snippet',
        mine: 'true',
        maxResults: '50',
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const parsed = schema.safeParse(
        await this.json(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      if (!parsed.success) throw new GoogleProviderError('GOOGLE_UNAVAILABLE');
      for (const item of parsed.data.items) {
        channels.set(
          item.id,
          Object.freeze({
            youtube_channel_id: item.id,
            channel_title: item.snippet.title,
          }),
        );
      }
      const next = parsed.data.nextPageToken;
      if (!next) return [...channels.values()];
      if (visited.has(next)) throw new GoogleProviderError('YOUTUBE_LOOKUP_INCOMPLETE');
      visited.add(next);
      pageToken = next;
    }
    // Never provision a partial ownership list.
    throw new GoogleProviderError('YOUTUBE_LOOKUP_INCOMPLETE');
  }

  async verifyBroadcast(accessToken: string, broadcastId: string): Promise<VerifiedBroadcast> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(broadcastId)) {
      throw new GoogleProviderError('INVALID_BROADCAST_ID');
    }

    const broadcastUrl = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts');

    broadcastUrl.search = new URLSearchParams({
      part: 'id,snippet,status',
      id: broadcastId,
    }).toString();

    const broadcastSchema = z.object({
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            snippet: z.object({
              channelId: z.string().min(1).max(128),
              title: z.string().min(1),
              liveChatId: z.string().max(1024).optional(),
            }),
            status: z.object({
              lifeCycleStatus: z.string(),
            }),
          }),
        )
        .default([]),
    });

    const broadcastResult = broadcastSchema.safeParse(
      await this.json(broadcastUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );

    if (!broadcastResult.success) {
      throw new GoogleProviderError('GOOGLE_UNAVAILABLE');
    }

    const broadcast = broadcastResult.data.items.find((item) => item.id === broadcastId);

    if (!broadcast) {
      throw new GoogleProviderError('BROADCAST_NOT_FOUND');
    }

    const channelSchema = z.object({
      items: z
        .array(
          z.object({
            id: z.string().min(1).max(128),
            snippet: z.object({
              title: z.string().min(1),
            }),
          }),
        )
        .default([]),
      nextPageToken: z.string().min(1).optional(),
    });

    let pageToken: string | undefined;
    let channelTitle: string | undefined;
    const visitedTokens = new Set<string>();

    // Bound provider requests and reject incomplete ownership checks.
    for (let page = 0; page < 10; page++) {
      const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');

      channelUrl.search = new URLSearchParams({
        part: 'id,snippet',
        mine: 'true',
        maxResults: '50',
        ...(pageToken ? { pageToken } : {}),
      }).toString();

      const channelResult = channelSchema.safeParse(
        await this.json(channelUrl.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );

      if (!channelResult.success) {
        throw new GoogleProviderError('GOOGLE_UNAVAILABLE');
      }

      const ownedChannel = channelResult.data.items.find(
        (item) => item.id === broadcast.snippet.channelId,
      );

      if (ownedChannel) {
        channelTitle = ownedChannel.snippet.title;
        break;
      }

      const nextToken = channelResult.data.nextPageToken;

      if (!nextToken) {
        throw new GoogleProviderError('BROADCAST_NOT_OWNED');
      }

      if (visitedTokens.has(nextToken)) {
        throw new GoogleProviderError('YOUTUBE_LOOKUP_INCOMPLETE');
      }

      visitedTokens.add(nextToken);
      pageToken = nextToken;
    }

    if (!channelTitle) {
      throw new GoogleProviderError('YOUTUBE_LOOKUP_INCOMPLETE');
    }

    if (broadcast.status.lifeCycleStatus !== 'live') {
      throw new GoogleProviderError('BROADCAST_NOT_LIVE');
    }

    if (!broadcast.snippet.liveChatId) {
      throw new GoogleProviderError('LIVE_CHAT_UNAVAILABLE');
    }

    return Object.freeze({
      youtube_broadcast_id: broadcast.id,
      youtube_channel_id: broadcast.snippet.channelId,
      channel_title: channelTitle,
      title: broadcast.snippet.title,
      live_chat_id: broadcast.snippet.liveChatId,
    });
  }

  async broadcasts(accessToken: string) {
    // mine and broadcastStatus are mutually exclusive filters. Filter lifecycle locally.
    const url = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts');
    url.search = new URLSearchParams({
      part: 'id,snippet,status',
      mine: 'true',
      maxResults: '50',
      broadcastType: 'all',
    }).toString();
    const schema = z.object({
      items: z
        .array(
          z.object({
            id: z.string(),
            snippet: z.object({
              title: z.string(),
              channelId: z.string(),
              liveChatId: z.string().optional(),
              scheduledStartTime: z.string().optional(),
            }),
            status: z.object({ lifeCycleStatus: z.string() }),
          }),
        )
        .default([]),
      nextPageToken: z.string().optional(),
    });
    const data = schema.parse(
      await this.json(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } }),
    );
    return {
      items: data.items
        .filter((item) => item.status.lifeCycleStatus === 'live')
        .map((item) => ({
          youtube_broadcast_id: item.id,
          youtube_channel_id: item.snippet.channelId,
          title: item.snippet.title,
          live_chat_available: Boolean(item.snippet.liveChatId),
          scheduled_start_time: item.snippet.scheduledStartTime ?? null,
        })),
      truncated: Boolean(data.nextPageToken),
    };
  }
}
