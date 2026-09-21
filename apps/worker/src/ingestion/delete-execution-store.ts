import { uuid } from '@moderator/contracts';
import {
  appendLiveEvent,
  transaction,
  type createPool,
  type PoolClient,
} from '@moderator/persistence';
import type { YoutubeDeleteResult } from '@moderator/provider-adapters';
import { randomUUID } from 'node:crypto';

type DatabasePool = ReturnType<typeof createPool>;

export type DeleteExecution = {
  id: string;
  plan_id: string;
  channel_id: string;
  session_id: string;
  external_message_id: string;
};

export type DeleteClaim = Readonly<{
  execution: DeleteExecution;
  attempt_id: string;
  owner_id: string;
  deadline_at: string;
}>;

export class DeleteExecutionStore {
  constructor(private readonly pool: DatabasePool) {}

  async ensure(planId: string, channelId: string, sessionId: string): Promise<DeleteExecution> {
    [planId, channelId, sessionId].forEach((value) => uuid.parse(value));
    return transaction(this.pool, async (client) => {
      const source = await client.query<{ external_message_id: string }>(
        `SELECT o.external_message_id
         FROM youtube_moderation_action_plans p
         JOIN youtube_chat_classifications c ON c.id = p.classification_id
           AND c.channel_id = p.channel_id AND c.session_id = p.session_id
         JOIN youtube_chat_observations o ON o.id = c.observation_id
           AND o.channel_id = c.channel_id AND o.session_id = c.session_id
         WHERE p.id = $1 AND p.channel_id = $2 AND p.session_id = $3 AND p.action = 'DELETE'`,
        [planId, channelId, sessionId],
      );
      const message = source.rows[0];
      if (!message) throw new Error('A DELETE plan in the requested scope is required.');

      const inserted = await client.query<DeleteExecution>(
        `INSERT INTO youtube_delete_executions(id, plan_id, channel_id, session_id, external_message_id)
         VALUES($1, $2, $3, $4, $5)
         ON CONFLICT(channel_id, session_id, external_message_id) DO NOTHING
         RETURNING id, plan_id, channel_id, session_id, external_message_id`,
        [randomUUID(), planId, channelId, sessionId, message.external_message_id],
      );
      if (inserted.rows[0]) return inserted.rows[0];
      const existing = await client.query<DeleteExecution>(
        `SELECT id, plan_id, channel_id, session_id, external_message_id
         FROM youtube_delete_executions
         WHERE channel_id = $1 AND session_id = $2 AND external_message_id = $3`,
        [channelId, sessionId, message.external_message_id],
      );
      if (!existing.rows[0]) throw new Error('The deletion execution could not be read.');
      return existing.rows[0];
    });
  }

  /** Commits a dispatch marker before returning. No provider request belongs in this transaction. */
  async claim(
    executionId: string,
    ownerId: string,
    timeoutSeconds = 30,
  ): Promise<DeleteClaim | null> {
    uuid.parse(executionId);
    uuid.parse(ownerId);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 15 || timeoutSeconds > 300) {
      throw new Error('Deletion attempt duration must be between 15 and 300 seconds.');
    }
    return transaction(this.pool, async (client) => {
      const locked = await client.query<DeleteExecution>(
        `SELECT id, plan_id, channel_id, session_id, external_message_id
         FROM youtube_delete_executions WHERE id = $1 FOR UPDATE`,
        [executionId],
      );
      const execution = locked.rows[0];
      if (!execution) return null;

      // Retries require a separate eligibility policy. Never redispatch from this method.
      const previous = await client.query(
        'SELECT id FROM youtube_delete_attempts WHERE execution_id = $1 LIMIT 1',
        [executionId],
      );
      if (previous.rows.length) return null;

      const attemptId = randomUUID();
      const inserted = await client.query<{ deadline_at: Date }>(
        `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO youtube_delete_attempts(
           id, execution_id, attempt_number, owner_id, started_at, deadline_at
         )
         SELECT $1, $2, 1, $3, at, at + $4 * interval '1 second' FROM moment
         RETURNING deadline_at`,
        [attemptId, executionId, ownerId, timeoutSeconds],
      );
      await this.publishChatUpdates(client, [executionId]);
      return Object.freeze({
        execution,
        attempt_id: attemptId,
        owner_id: ownerId,
        deadline_at: inserted.rows[0]!.deadline_at.toISOString(),
      });
    });
  }

  /** False means this claim can no longer record a result. It never authorizes another send. */
  async complete(claim: DeleteClaim, result: YoutubeDeleteResult): Promise<boolean> {
    uuid.parse(claim.attempt_id);
    uuid.parse(claim.owner_id);
    uuid.parse(claim.execution.id);
    return transaction(this.pool, async (client) => {
      // Acquire the row before checking wall-clock expiry, including lock wait time.
      const owned = await client.query(
        `SELECT id FROM youtube_delete_attempts
         WHERE id = $1 AND execution_id = $2 AND owner_id = $3 FOR UPDATE`,
        [claim.attempt_id, claim.execution.id, claim.owner_id],
      );
      if (!owned.rows.length) return false;
      const response = await client.query(
        `UPDATE youtube_delete_attempts
         SET status = $4, http_status = $5, error_code = $6,
             finished_at = GREATEST(clock_timestamp(), started_at)
         WHERE id = $1 AND execution_id = $2 AND owner_id = $3
           AND status = 'DISPATCHED' AND deadline_at > clock_timestamp()
         RETURNING id`,
        [
          claim.attempt_id,
          claim.execution.id,
          claim.owner_id,
          result.status,
          result.status === 'NOT_SENT' ? null : result.http_status,
          result.status === 'SUCCEEDED' ? null : result.code,
        ],
      );
      if (response.rowCount !== 1) return false;
      await this.publishChatUpdates(client, [claim.execution.id]);
      return true;
    });
  }

  /** Conservative crash recovery: an expired dispatch may already have changed YouTube. */
  async recoverExpired(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Recovery batch size must be between 1 and 1000.');
    }
    return transaction(this.pool, async (client) => {
      const result = await client.query<{ execution_id: string }>(
        `WITH expired AS (
         SELECT id FROM youtube_delete_attempts
         WHERE status = 'DISPATCHED' AND deadline_at <= clock_timestamp()
         ORDER BY deadline_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE youtube_delete_attempts a
       SET status = 'UNKNOWN', error_code = 'EXECUTION_DEADLINE_EXCEEDED',
           finished_at = GREATEST(clock_timestamp(), a.started_at)
       FROM expired WHERE a.id = expired.id AND a.status = 'DISPATCHED'
       RETURNING a.execution_id`,
        [limit],
      );
      await this.publishChatUpdates(
        client,
        result.rows.map((row) => row.execution_id),
      );
      return result.rowCount ?? 0;
    });
  }

  private async publishChatUpdates(client: PoolClient, executionIds: string[]): Promise<void> {
    if (!executionIds.length) return;
    // Resolve scope from persisted provenance, not from the caller's claim object.
    // Consistent counter lock order avoids cycles between concurrent recovery batches.
    const scopes = await client.query<{ channel_id: string; session_id: string; run_id: string }>(
      `SELECT DISTINCT e.channel_id, e.session_id, c.run_id
       FROM youtube_delete_executions e
       JOIN youtube_moderation_action_plans p ON p.id = e.plan_id
         AND p.channel_id = e.channel_id AND p.session_id = e.session_id
       JOIN youtube_chat_classifications c ON c.id = p.classification_id
         AND c.channel_id = p.channel_id AND c.session_id = p.session_id
       WHERE e.id = ANY($1::uuid[])
       ORDER BY e.channel_id, e.session_id, c.run_id`,
      [executionIds],
    );
    for (const scope of scopes.rows) {
      await appendLiveEvent(client, {
        channelId: scope.channel_id,
        sessionId: scope.session_id,
        runId: scope.run_id,
        type: 'chat.updated',
      });
    }
  }
}
