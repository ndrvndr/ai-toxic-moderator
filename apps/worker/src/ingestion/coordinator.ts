import type { createPool } from '@moderator/persistence';
import { GoogleProviderError, YoutubeChatError } from '@moderator/provider-adapters';
import { randomUUID } from 'node:crypto';

import {
  ChatAlreadyEndedError,
  MonitoringNotIngestingError,
  StaleBatchError,
} from './batch-writer';
import { LeaseLostError, LeaseStore, type WorkerLease } from './lease-store';
import { PollCycle } from './poll-cycle';
import { RetryStore, type RetryableErrorCode } from './retry-store';

type DatabasePool = ReturnType<typeof createPool>;

export class IngestionCoordinator {
  constructor(
    private readonly pool: DatabasePool,
    private readonly leases: LeaseStore,
    private readonly cycle: Pick<PollCycle, 'run'>,
    private readonly retries: RetryStore,
    private readonly ownerId = randomUUID(),
  ) {}

  async tick(signal?: AbortSignal) {
    if (signal?.aborted) return { kind: 'CANCELLED' as const };

    const candidates = await this.pool.query<{ id: string }>(
      `
        SELECT run.id
        FROM monitoring_runs run
        LEFT JOIN monitoring_worker_leases lease
          ON lease.run_id = run.id
        LEFT JOIN youtube_chat_checkpoints checkpoint
          ON checkpoint.session_id = run.session_id
        WHERE run.status IN ('STARTING', 'RUNNING', 'STOPPING')
          AND (
            lease.owner_id IS NULL
            OR lease.expires_at <= clock_timestamp()
          )
          AND (
            run.status = 'STOPPING'
            OR checkpoint.chat_ended_at IS NOT NULL
            OR checkpoint.session_id IS NULL
            OR checkpoint.next_poll_at <= clock_timestamp()
          )
        ORDER BY
          CASE
            WHEN run.status = 'STOPPING' THEN 0
            WHEN checkpoint.chat_ended_at IS NOT NULL THEN 1
            ELSE 2
          END,
          COALESCE(checkpoint.next_poll_at, run.requested_at),
          run.id
        LIMIT 1
      `,
    );

    const candidate = candidates.rows[0];

    if (!candidate) return { kind: 'IDLE' as const };

    return this.process(candidate.id, signal);
  }

  async process(runId: string, signal?: AbortSignal) {
    if (signal?.aborted) return { kind: 'CANCELLED' as const };

    const lease = await this.leases.claim(runId, this.ownerId);

    if (!lease) return { kind: 'BUSY' as const };

    try {
      return await this.execute(lease, signal);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return { kind: 'LEASE_LOST' as const };
      }

      throw error;
    } finally {
      try {
        await this.leases.release(lease);
      } catch (error) {
        // Finalization and ownership loss both make release unnecessary.
        if (!(error instanceof LeaseLostError)) throw error;
      }
    }
  }

  private async execute(lease: WorkerLease, signal?: AbortSignal) {
    try {
      const result = await this.cycle.run(lease, signal);

      if (
        result.kind === 'STOP_REQUESTED' ||
        result.kind === 'CHAT_ENDED' ||
        (result.kind === 'POLLED' && result.chat_ended)
      ) {
        return {
          kind: await this.leases.finish(lease, 'STOPPED'),
        };
      }

      return result;
    } catch (error) {
      return this.handleError(lease, error, signal);
    }
  }

  private async handleError(lease: WorkerLease, error: unknown, signal?: AbortSignal) {
    if (error instanceof LeaseLostError) throw error;

    if (
      signal?.aborted ||
      (error instanceof YoutubeChatError && error.code === 'REQUEST_CANCELLED')
    ) {
      return { kind: 'CANCELLED' as const };
    }

    if (error instanceof ChatAlreadyEndedError || error instanceof MonitoringNotIngestingError) {
      return {
        kind: await this.leases.finish(lease, 'STOPPED'),
      };
    }

    if (error instanceof StaleBatchError) {
      return { kind: 'STALE' as const };
    }

    if (!(error instanceof YoutubeChatError) && !(error instanceof GoogleProviderError)) {
      throw error;
    }

    if (error.code === 'LIVE_CHAT_ENDED') {
      return {
        kind: await this.leases.finish(lease, 'STOPPED'),
      };
    }

    const retryable: RetryableErrorCode | null =
      error.code === 'GOOGLE_UNAVAILABLE' ||
      error.code === 'YOUTUBE_UNAVAILABLE' ||
      error.code === 'YOUTUBE_RATE_LIMITED'
        ? error.code
        : null;

    if (!retryable) {
      return {
        kind: await this.leases.finish(lease, 'FAILED', error.code),
      };
    }

    const retryAfterMs = error instanceof YoutubeChatError ? error.retryAfterMs : null;

    // Do not shorten an unsupported provider delay and retry too early.
    if (
      retryAfterMs !== null &&
      (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 2147483647)
    ) {
      return {
        kind: await this.leases.finish(lease, 'FAILED', 'RETRY_DELAY_UNSUPPORTED'),
      };
    }

    try {
      const scheduled = await this.retries.schedule(lease, retryable, retryAfterMs);

      if (scheduled.consecutive_failures >= 8) {
        return {
          kind: await this.leases.finish(lease, 'FAILED', retryable),
        };
      }

      return {
        kind: 'RETRY' as const,
        error_code: retryable,
        next_poll_at: scheduled.next_poll_at,
      };
    } catch (retryError) {
      if (retryError instanceof MonitoringNotIngestingError) {
        return {
          kind: await this.leases.finish(lease, 'STOPPED'),
        };
      }

      throw retryError;
    }
  }
}
