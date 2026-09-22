import { appendLiveEvent } from '@moderator/persistence';
import { MonitoringNotIngestingError } from './batch-writer';
import { LeaseStore, type WorkerLease } from './lease-store';

export type RetryableErrorCode =
  | 'GOOGLE_UNAVAILABLE'
  | 'YOUTUBE_UNAVAILABLE'
  | 'YOUTUBE_RATE_LIMITED';

export class RetryStore {
  constructor(private readonly leases: LeaseStore) {}

  async schedule(lease: WorkerLease, code: RetryableErrorCode, retryAfterMs: number | null = null) {
    if (!['GOOGLE_UNAVAILABLE', 'YOUTUBE_UNAVAILABLE', 'YOUTUBE_RATE_LIMITED'].includes(code)) {
      throw new Error('The error is not eligible for automatic retry.');
    }

    if (
      retryAfterMs !== null &&
      (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 2147483647)
    ) {
      throw new Error('The retry delay is outside the supported range.');
    }

    return this.leases.withLease(lease, async (client) => {
      const result = await client.query<{
        channel_id: string;
        session_id: string;
        status: string;
      }>('SELECT channel_id, session_id, status FROM monitoring_runs WHERE id = $1', [
        lease.run_id,
      ]);

      const run = result.rows[0];

      if (!run || !['STARTING', 'RUNNING'].includes(run.status)) {
        throw new MonitoringNotIngestingError();
      }

      await client.query(
        `
          INSERT INTO youtube_chat_checkpoints(session_id)
          VALUES($1)
          ON CONFLICT(session_id) DO NOTHING
        `,
        [run.session_id],
      );

      const checkpoint = await client.query<{
        consecutive_failures: number;
      }>(
        `
          SELECT consecutive_failures
          FROM youtube_chat_checkpoints
          WHERE session_id = $1
          FOR UPDATE
        `,
        [run.session_id],
      );

      const failures = checkpoint.rows[0]!.consecutive_failures;
      const backoffMs = Math.min(300000, 1000 * 2 ** Math.min(failures, 9));
      const delayMs = Math.max(backoffMs, retryAfterMs ?? 0);

      const updated = await client.query<{
        revision: string;
        next_poll_at: Date;
        consecutive_failures: number;
      }>(
        `
          WITH moment AS MATERIALIZED (
            SELECT clock_timestamp() AS at
          )
          UPDATE youtube_chat_checkpoints
          SET
            revision = revision + 1,
            consecutive_failures = LEAST(consecutive_failures, 2147483646) + 1,
            next_poll_at = GREATEST(
              next_poll_at,
              moment.at + $2 * interval '1 millisecond'
            ),
            last_error_code = $3,
            updated_at = moment.at
          FROM moment
          WHERE session_id = $1
          RETURNING revision::text, next_poll_at, consecutive_failures
        `,
        [run.session_id, delayMs, code],
      );

      await client.query('UPDATE monitoring_runs SET last_error_code = $2 WHERE id = $1', [
        lease.run_id,
        code,
      ]);

      await appendLiveEvent(client, {
        channelId: run.channel_id,
        sessionId: run.session_id,
        runId: lease.run_id,
        type: 'monitoring.updated',
      });

      const row = updated.rows[0]!;

      return {
        revision: row.revision,
        next_poll_at: row.next_poll_at.toISOString(),
        consecutive_failures: row.consecutive_failures,
      };
    });
  }
}
