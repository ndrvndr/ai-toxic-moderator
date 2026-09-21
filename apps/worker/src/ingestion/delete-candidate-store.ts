import type { createPool } from '@moderator/persistence';

export type DeleteCandidate = { planId: string; channelId: string; sessionId: string };

export class DeleteCandidateStore {
  constructor(private readonly pool: ReturnType<typeof createPool>) {}

  /** Discovery only; the executor must revalidate original provenance before dispatch. */
  async next(after: string | null): Promise<DeleteCandidate | null> {
    const result = await this.pool.query<DeleteCandidate>(
      `SELECT p.id AS "planId", p.channel_id AS "channelId", p.session_id AS "sessionId"
       FROM youtube_moderation_action_plans p
       JOIN youtube_chat_classifications c ON c.id = p.classification_id
         AND c.channel_id = p.channel_id AND c.session_id = p.session_id
       JOIN youtube_chat_observations o ON o.id = c.observation_id
         AND o.channel_id = c.channel_id AND o.session_id = c.session_id
       JOIN monitoring_runs r ON r.id = c.run_id
         AND r.channel_id = c.channel_id AND r.session_id = c.session_id
       LEFT JOIN youtube_delete_executions e ON e.channel_id = p.channel_id
         AND e.session_id = p.session_id AND e.external_message_id = o.external_message_id
       WHERE p.action = 'DELETE' AND r.status = 'RUNNING' AND r.stop_requested_at IS NULL
         AND ($1::uuid IS NULL OR p.id > $1::uuid)
         AND NOT EXISTS (SELECT 1 FROM youtube_delete_attempts a WHERE a.execution_id = e.id)
       ORDER BY p.id LIMIT 1`,
      [after],
    );
    return result.rows[0] ?? null;
  }
}
