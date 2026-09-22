import { uuid } from '@moderator/contracts';
import type { createPool } from '@moderator/persistence';
import type { BanExecution } from './ban-execution-store';
import type { BanEligibility } from './ban-executor';

/** Read current authorization without loading token ciphertext or contacting Google. */
export class BanEligibilityStore implements BanEligibility {
  constructor(
    private readonly pool: ReturnType<typeof createPool>,
    private readonly isEnabled: () => boolean,
    private readonly allowedTestPolicyVersion: string | null = null,
  ) {}

  async resolve(execution: Readonly<BanExecution>): Promise<{ accountId: string } | null> {
    if (!this.isEnabled()) return null;
    for (const value of [
      execution.id,
      execution.plan_id,
      execution.channel_id,
      execution.session_id,
    ]) {
      uuid.parse(value);
    }
    const result = await this.pool.query<{ account_id: string }>(
      `SELECT r.credential_account_id AS account_id
       FROM youtube_ban_executions e
       JOIN youtube_moderation_action_plans p ON p.id = e.plan_id
         AND p.channel_id = e.channel_id AND p.session_id = e.session_id
       JOIN youtube_chat_classifications c ON c.id = p.classification_id
         AND c.channel_id = p.channel_id AND c.session_id = p.session_id
       JOIN youtube_chat_observations o ON o.id = c.observation_id
         AND o.channel_id = c.channel_id AND o.session_id = c.session_id
       JOIN monitoring_runs r ON r.id = c.run_id
         AND r.channel_id = c.channel_id AND r.session_id = c.session_id
       JOIN youtube_broadcasts b ON b.channel_id = e.channel_id AND b.session_id = e.session_id
       JOIN stream_sessions s ON s.id = r.session_id AND s.channel_id = r.channel_id
       JOIN youtube_chat_checkpoints cp ON cp.session_id = r.session_id
       JOIN google_credentials g ON g.account_id = r.credential_account_id
       JOIN channel_memberships credential_member ON credential_member.channel_id = r.channel_id
         AND credential_member.account_id = r.credential_account_id
       JOIN channel_memberships requester_member ON requester_member.channel_id = r.channel_id
         AND requester_member.account_id = r.requested_by_account_id
       WHERE e.id = $1 AND e.plan_id = $2 AND e.channel_id = $3 AND e.session_id = $4
         AND e.live_chat_id = $5 AND e.author_channel_id = $6 AND e.action = $7
         AND e.duration_seconds IS NOT DISTINCT FROM $8::bigint
         AND (
  (
    $9::text IS NULL
    AND p.policy_version NOT LIKE 'ban-test-%'
  )
  OR p.policy_version = $9::text
)
         AND b.live_chat_id = e.live_chat_id AND p.action = e.action
         AND p.duration_seconds IS NOT DISTINCT FROM e.duration_seconds
         AND COALESCE(o.payload #>> '{authorDetails,channelId}', o.payload #>> '{snippet,authorChannelId}') = e.author_channel_id
         AND p.action IN ('TIMEOUT', 'BAN') AND o.event_type = 'textMessageEvent'
         AND r.status = 'RUNNING' AND r.stop_requested_at IS NULL AND r.finished_at IS NULL
         AND s.source = 'YOUTUBE' AND s.closed_at IS NULL AND cp.chat_ended_at IS NULL
         AND credential_member.role IN ('OWNER', 'MODERATOR')
         AND requester_member.role IN ('OWNER', 'MODERATOR')
         AND regexp_split_to_array(g.scopes, '[[:space:]]+') && ARRAY[
           'https://www.googleapis.com/auth/youtube',
           'https://www.googleapis.com/auth/youtube.force-ssl'
         ]::text[]`,
      [
        execution.id,
        execution.plan_id,
        execution.channel_id,
        execution.session_id,
        execution.live_chat_id,
        execution.author_channel_id,
        execution.action,
        execution.duration_seconds,
        this.allowedTestPolicyVersion,
      ],
    );
    // Configuration may have changed while the database request was in flight.
    if (!this.isEnabled()) return null;
    const row = result.rows[0];
    return row ? { accountId: row.account_id } : null;
  }
}
