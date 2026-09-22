import { uuid } from '@moderator/contracts';
import {
  appendLiveEvent,
  transaction,
  type createPool,
  type PoolClient,
} from '@moderator/persistence';
import type { YoutubeBanResult } from '@moderator/provider-adapters';
import { randomUUID } from 'node:crypto';

export type BanExecution = {
  id: string;
  plan_id: string;
  channel_id: string;
  session_id: string;
  live_chat_id: string;
  author_channel_id: string;
  action: 'TIMEOUT' | 'BAN';
  duration_seconds: string | null;
};
export type BanClaim = Readonly<{
  execution: BanExecution;
  attempt_id: string;
  owner_id: string;
  deadline_at: string;
}>;
const columns =
  'id, plan_id, channel_id, session_id, live_chat_id, author_channel_id, action, duration_seconds::text';

export class BanExecutionStore {
  constructor(private readonly pool: ReturnType<typeof createPool>) {}

  async ensure(planId: string, channelId: string, sessionId: string): Promise<BanExecution> {
    [planId, channelId, sessionId].forEach((value) => uuid.parse(value));
    return transaction(this.pool, async (client) => {
      const source = await client.query<
        Pick<BanExecution, 'live_chat_id' | 'author_channel_id' | 'action' | 'duration_seconds'>
      >(
        `SELECT b.live_chat_id, COALESCE(o.payload #>> '{authorDetails,channelId}',
          o.payload #>> '{snippet,authorChannelId}') AS author_channel_id, p.action, p.duration_seconds::text
         FROM youtube_moderation_action_plans p
         JOIN youtube_chat_classifications c ON c.id = p.classification_id
           AND c.channel_id = p.channel_id AND c.session_id = p.session_id
         JOIN youtube_chat_observations o ON o.id = c.observation_id
           AND o.channel_id = c.channel_id AND o.session_id = c.session_id
         JOIN youtube_broadcasts b ON b.channel_id = p.channel_id AND b.session_id = p.session_id
         WHERE p.id = $1 AND p.channel_id = $2 AND p.session_id = $3 AND p.action IN ('TIMEOUT', 'BAN')`,
        [planId, channelId, sessionId],
      );
      const target = source.rows[0];
      if (!target?.author_channel_id?.trim())
        throw new Error('A scoped author-targeted plan is required.');
      const inserted = await client.query<BanExecution>(
        `INSERT INTO youtube_ban_executions(id, plan_id, channel_id, session_id, live_chat_id, author_channel_id, action, duration_seconds)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING RETURNING ${columns}`,
        [
          randomUUID(),
          planId,
          channelId,
          sessionId,
          target.live_chat_id,
          target.author_channel_id,
          target.action,
          target.duration_seconds,
        ],
      );
      if (inserted.rows[0]) return inserted.rows[0];
      const existing = await client.query<BanExecution>(
        `SELECT ${columns} FROM youtube_ban_executions WHERE channel_id=$1 AND session_id=$2 AND author_channel_id=$3`,
        [channelId, sessionId, target.author_channel_id],
      );
      const row = existing.rows[0];
      if (
        !row ||
        row.action !== target.action ||
        row.duration_seconds !== target.duration_seconds ||
        row.live_chat_id !== target.live_chat_id
      ) {
        throw new Error('An incompatible author execution already exists.');
      }
      return row;
    });
  }

  async claim(executionId: string, ownerId: string, timeoutSeconds = 30): Promise<BanClaim | null> {
    uuid.parse(executionId);
    uuid.parse(ownerId);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 15 || timeoutSeconds > 300) {
      throw new Error('Ban attempt duration must be between 15 and 300 seconds.');
    }
    return transaction(this.pool, async (client) => {
      const locked = await client.query<BanExecution>(
        `SELECT ${columns} FROM youtube_ban_executions WHERE id=$1 FOR UPDATE`,
        [executionId],
      );
      const execution = locked.rows[0];
      if (!execution) return null;
      const previous = await client.query(
        'SELECT id FROM youtube_ban_attempts WHERE execution_id=$1',
        [executionId],
      );
      if (previous.rows.length) return null;
      const attemptId = randomUUID();
      const inserted = await client.query<{ deadline_at: Date }>(
        `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO youtube_ban_attempts(id, execution_id, owner_id, started_at, deadline_at)
         SELECT $1,$2,$3,at,at + $4 * interval '1 second' FROM moment RETURNING deadline_at`,
        [attemptId, executionId, ownerId, timeoutSeconds],
      );
      await this.publish(client, [executionId]);
      return Object.freeze({
        execution,
        attempt_id: attemptId,
        owner_id: ownerId,
        deadline_at: inserted.rows[0]!.deadline_at.toISOString(),
      });
    });
  }

  async complete(claim: BanClaim, result: YoutubeBanResult): Promise<boolean> {
    [claim.attempt_id, claim.owner_id, claim.execution.id].forEach((value) => uuid.parse(value));
    return transaction(this.pool, async (client) => {
      const owned = await client.query(
        'SELECT id FROM youtube_ban_attempts WHERE id=$1 AND execution_id=$2 AND owner_id=$3 FOR UPDATE',
        [claim.attempt_id, claim.execution.id, claim.owner_id],
      );
      if (!owned.rows.length) return false;
      const saved = await client.query(
        `UPDATE youtube_ban_attempts SET status=$4, http_status=$5, error_code=$6, ban_id=$7,
         finished_at=GREATEST(clock_timestamp(), started_at)
         WHERE id=$1 AND execution_id=$2 AND owner_id=$3 AND status='DISPATCHED' AND deadline_at>clock_timestamp() RETURNING id`,
        [
          claim.attempt_id,
          claim.execution.id,
          claim.owner_id,
          result.status,
          result.status === 'NOT_SENT' ? null : result.http_status,
          result.status === 'SUCCEEDED' ? null : result.code,
          result.status === 'SUCCEEDED' ? result.ban_id : null,
        ],
      );
      if (saved.rowCount !== 1) return false;
      await this.publish(client, [claim.execution.id]);
      return true;
    });
  }

  async recoverExpired(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Recovery batch size must be between 1 and 1000.');
    return transaction(this.pool, async (client) => {
      const result = await client.query<{ execution_id: string }>(
        `WITH expired AS (
           SELECT id FROM youtube_ban_attempts WHERE status='DISPATCHED' AND deadline_at<=clock_timestamp()
           ORDER BY deadline_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
         ) UPDATE youtube_ban_attempts a SET status='UNKNOWN', error_code='EXECUTION_DEADLINE_EXCEEDED',
           finished_at=GREATEST(clock_timestamp(), a.started_at)
         FROM expired WHERE a.id=expired.id AND a.status='DISPATCHED' RETURNING a.execution_id`,
        [limit],
      );
      await this.publish(
        client,
        result.rows.map((row) => row.execution_id),
      );
      return result.rowCount ?? 0;
    });
  }

  private async publish(client: PoolClient, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const scopes = await client.query<{ channel_id: string; session_id: string; run_id: string }>(
      `SELECT DISTINCT e.channel_id,e.session_id,c.run_id FROM youtube_ban_executions e
       JOIN youtube_moderation_action_plans p ON p.id=e.plan_id AND p.channel_id=e.channel_id AND p.session_id=e.session_id
       JOIN youtube_chat_classifications c ON c.id=p.classification_id AND c.channel_id=p.channel_id AND c.session_id=p.session_id
       WHERE e.id=ANY($1::uuid[]) ORDER BY e.channel_id,e.session_id,c.run_id`,
      [ids],
    );
    for (const row of scopes.rows)
      await appendLiveEvent(client, {
        channelId: row.channel_id,
        sessionId: row.session_id,
        runId: row.run_id,
        type: 'chat.updated',
      });
  }
}
