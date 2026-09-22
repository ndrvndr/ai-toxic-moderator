import type { createPool } from '@moderator/persistence';

export type BanCandidate = {
  planId: string;
  channelId: string;
  sessionId: string;
};

export class BanCandidateStore {
  constructor(private readonly pool: ReturnType<typeof createPool>) {}

  /** Discovery only. The executor revalidates authorization before dispatch. */
  async next(after: string | null): Promise<BanCandidate | null> {
    const result = await this.pool.query<BanCandidate>(
      `
        SELECT
          p.id AS "planId",
          p.channel_id AS "channelId",
          p.session_id AS "sessionId"
        FROM youtube_moderation_action_plans p
        JOIN youtube_chat_classifications c
          ON c.id = p.classification_id
          AND c.channel_id = p.channel_id
          AND c.session_id = p.session_id
        JOIN youtube_chat_observations o
          ON o.id = c.observation_id
          AND o.channel_id = c.channel_id
          AND o.session_id = c.session_id
        JOIN monitoring_runs r
          ON r.id = c.run_id
          AND r.channel_id = c.channel_id
          AND r.session_id = c.session_id
        LEFT JOIN youtube_ban_executions e
          ON e.channel_id = p.channel_id
          AND e.session_id = p.session_id
          AND e.author_channel_id = COALESCE(
            o.payload #>> '{authorDetails,channelId}',
            o.payload #>> '{snippet,authorChannelId}'
          )
        WHERE p.action IN ('TIMEOUT', 'BAN')
          AND r.status = 'RUNNING'
          AND r.stop_requested_at IS NULL
          AND ($1::uuid IS NULL OR p.id > $1::uuid)
          AND NULLIF(
            BTRIM(COALESCE(
              o.payload #>> '{authorDetails,channelId}',
              o.payload #>> '{snippet,authorChannelId}'
            )),
            ''
          ) IS NOT NULL
          AND (
            e.id IS NULL
            OR (
              e.action = p.action
              AND e.duration_seconds IS NOT DISTINCT FROM p.duration_seconds
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM youtube_ban_attempts a
            WHERE a.execution_id = e.id
          )
        ORDER BY p.id
        LIMIT 1
      `,
      [after],
    );

    return result.rows[0] ?? null;
  }
}
