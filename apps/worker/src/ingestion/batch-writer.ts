import { youtubeIngestionBatch } from '@moderator/contracts';
import type { PoolClient } from '@moderator/persistence';
import { createHash, randomUUID } from 'node:crypto';

import { LeaseStore, type WorkerLease } from './lease-store';

export class StaleBatchError extends Error {
  constructor() {
    super('The polling checkpoint has already changed.');
    this.name = 'StaleBatchError';
  }
}

export class MonitoringNotIngestingError extends Error {
  constructor() {
    super('The monitoring run is not accepting chat batches.');
    this.name = 'MonitoringNotIngestingError';
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;

    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }

  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new Error('The resource must contain only JSON values.');
  }

  return serialized;
}

export class BatchWriter {
  constructor(private readonly leases: LeaseStore) {}

  async checkpoint(lease: WorkerLease) {
    return this.leases.withLease(lease, async (client) => {
      const run = await this.context(client, lease.run_id);

      await client.query(
        `
          INSERT INTO youtube_chat_checkpoints(session_id)
          VALUES($1)
          ON CONFLICT(session_id) DO NOTHING
        `,
        [run.session_id],
      );

      const result = await client.query<{
        revision: string;
        next_page_token: string | null;
        next_poll_at: Date;
        due: boolean;
        chat_ended_at: Date | null;
      }>(
        `
    SELECT
      revision::text,
      next_page_token,
      next_poll_at,
      next_poll_at <= clock_timestamp() AS due,
      chat_ended_at
    FROM youtube_chat_checkpoints
    WHERE session_id = $1
  `,
        [run.session_id],
      );

      const row = result.rows[0]!;

      return {
        revision: row.revision,
        next_page_token: row.next_page_token,
        next_poll_at: row.next_poll_at.toISOString(),
        due: row.due,
        chat_ended_at: row.chat_ended_at?.toISOString() ?? null,
      };
    });
  }

  async commit(lease: WorkerLease, input: unknown) {
    const batch = youtubeIngestionBatch.parse(input);

    return this.leases.withLease(lease, async (client) => {
      const run = await this.context(client, lease.run_id);

      const checkpoint = await client.query<{
        revision: string;
        next_page_token: string | null;
        chat_ended_at: Date | null;
      }>(
        `
          SELECT revision::text, next_page_token, chat_ended_at
          FROM youtube_chat_checkpoints
          WHERE session_id = $1
          FOR UPDATE
        `,
        [run.session_id],
      );

      const current = checkpoint.rows[0];

      if (
        !current ||
        current.revision !== batch.expected_revision ||
        current.next_page_token !== batch.request_page_token
      ) {
        throw new StaleBatchError();
      }

      if (current.chat_ended_at !== null) {
        throw new ChatAlreadyEndedError();
      }

      let inserted = 0;

      for (const item of batch.items) {
        if (item.snippet.liveChatId !== run.live_chat_id) {
          throw new Error('The chat resource belongs to another live chat.');
        }

        const payload = canonicalJson(item);
        const hash = createHash('sha256').update(payload).digest('hex');

        const result = await client.query(
          `
            INSERT INTO youtube_chat_observations(
              id,
              channel_id,
              session_id,
              first_observed_run_id,
              external_message_id,
              event_type,
              published_at,
              payload,
              payload_hash
            )
            VALUES($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
            ON CONFLICT(session_id, external_message_id, payload_hash)
            DO NOTHING
          `,
          [
            randomUUID(),
            run.channel_id,
            run.session_id,
            lease.run_id,
            item.id,
            item.snippet.type,
            item.snippet.publishedAt,
            payload,
            hash,
          ],
        );

        inserted += result.rowCount ?? 0;
      }

      const chatEnded =
        batch.items.some((item) => item.snippet.type === 'chatEndedEvent') ||
        (batch.offline_at !== null && batch.next_page_token === null);

      const updated = await client.query<{ revision: string }>(
        `
    WITH moment AS MATERIALIZED (
      SELECT clock_timestamp() AS at
    )
    UPDATE youtube_chat_checkpoints
    SET
      revision = revision + 1,
      next_page_token = $2,
      next_poll_at = moment.at + $3 * interval '1 millisecond',
      last_successful_poll_at = moment.at,
      consecutive_failures = 0,
      last_error_code = NULL,
      updated_at = moment.at,
      chat_ended_at = CASE
        WHEN $4 THEN COALESCE(chat_ended_at, moment.at)
        ELSE chat_ended_at
      END
    FROM moment
    WHERE session_id = $1
    RETURNING revision::text
  `,
        [run.session_id, batch.next_page_token, batch.polling_interval_ms, chatEnded],
      );

      await client.query(
        `
    UPDATE monitoring_runs
    SET
      status = 'RUNNING',
      started_at = COALESCE(
        started_at,
        GREATEST(clock_timestamp(), requested_at)
      ),
      last_error_code = NULL
    WHERE id = $1 AND status IN ('STARTING', 'RUNNING')
  `,
        [lease.run_id],
      );

      return {
        inserted,
        revision: updated.rows[0]!.revision,
      };
    });
  }

  private async context(client: PoolClient, runId: string) {
    const result = await client.query<{
      channel_id: string;
      session_id: string;
      live_chat_id: string;
      status: string;
    }>(
      `
        SELECT
          run.channel_id,
          run.session_id,
          run.status,
          broadcast.live_chat_id
        FROM monitoring_runs run
        JOIN youtube_broadcasts broadcast
          ON broadcast.channel_id = run.channel_id
          AND broadcast.session_id = run.session_id
        WHERE run.id = $1
      `,
      [runId],
    );

    const run = result.rows[0];

    if (!run || !['STARTING', 'RUNNING'].includes(run.status)) {
      throw new MonitoringNotIngestingError();
    }

    return run;
  }
}

export class ChatAlreadyEndedError extends Error {
  constructor() {
    super('The chat has already completed ingestion.');
    this.name = 'ChatAlreadyEndedError';
  }
}
