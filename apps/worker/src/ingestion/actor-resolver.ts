import type { YoutubeActorAdapter, YoutubeActorResult } from '@moderator/provider-adapters';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

type CacheEntry = {
  result: YoutubeActorResult;
  expiresAt: number;
};

function cancelled(): YoutubeActorResult {
  return {
    status: 'UNRESOLVED',
    code: 'REQUEST_CANCELLED',
    httpStatus: null,
  };
}

/** Process-local cache for the worker's sequential moderation coordinator. */
export class ActorResolver {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly adapter: Pick<YoutubeActorAdapter, 'resolve'>,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async resolve(accessToken: string, signal?: AbortSignal): Promise<YoutubeActorResult> {
    if (signal?.aborted) return cancelled();

    if (!accessToken || /\s/.test(accessToken)) {
      return {
        status: 'UNRESOLVED',
        code: 'INVALID_TOKEN',
        httpStatus: null,
      };
    }

    // Cache keys never contain the raw access token.
    const key = createHash('sha256').update(accessToken).digest('hex');
    const cached = this.entries.get(key);

    if (cached && cached.expiresAt > this.now()) {
      return { ...cached.result };
    }

    this.entries.delete(key);

    let result: YoutubeActorResult;

    try {
      result = await this.adapter.resolve(accessToken, signal);
    } catch {
      result = {
        status: 'UNRESOLVED',
        code: 'TRANSPORT_ERROR',
        httpStatus: null,
      };
    }

    if (signal?.aborted) return cancelled();

    if (result.status === 'UNRESOLVED' && result.code === 'REQUEST_CANCELLED') {
      return { ...result };
    }

    const ttl = result.status === 'RESOLVED' ? 5 * 60_000 : 60_000;

    const now = this.now();

    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(entryKey);
      }
    }

    if (this.entries.size >= 256) {
      const oldestKey = this.entries.keys().next().value;

      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    this.entries.set(key, {
      result: { ...result },
      expiresAt: now + ttl,
    });

    return { ...result };
  }
}
