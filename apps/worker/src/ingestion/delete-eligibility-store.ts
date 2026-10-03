import { uuid } from '@moderator/contracts';
import type { createPool } from '@moderator/persistence';
import type { DeleteExecution } from './delete-execution-store';
import type { DeleteEligibility } from './delete-executor';

/** Read current authorization without loading token ciphertext or contacting Google. */
export class DeleteEligibilityStore implements DeleteEligibility {
  constructor(
    private readonly pool: ReturnType<typeof createPool>,
    private readonly isEnabled: () => boolean,
    private readonly allowedTestPolicyVersion: string | null = null,
  ) {}

  async resolve(execution: Readonly<DeleteExecution>): Promise<{ accountId: string } | null> {
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
       FROM youtube_delete_executions e
       JOIN youtube_moderation_action_plans p ON p.id = e.plan_id
         AND p.channel_id = e.channel_id AND p.session_id = e.session_id
       JOIN youtube_chat_classifications c ON c.id = p.classification_id
         AND c.channel_id = p.channel_id AND c.session_id = p.session_id
       JOIN youtube_chat_observations o ON o.id = c.observation_id
         AND o.channel_id = c.channel_id AND o.session_id = c.session_id
       JOIN monitoring_runs r ON r.id = c.run_id
         AND r.channel_id = c.channel_id AND r.session_id = c.session_id
       JOIN stream_sessions s ON s.id = r.session_id AND s.channel_id = r.channel_id
       JOIN youtube_chat_checkpoints cp ON cp.session_id = r.session_id
       JOIN google_credentials g ON g.account_id = r.credential_account_id
       JOIN channel_memberships credential_member ON credential_member.channel_id = r.channel_id
         AND credential_member.account_id = r.credential_account_id
       JOIN channel_memberships requester_member ON requester_member.channel_id = r.channel_id
         AND requester_member.account_id = r.requested_by_account_id
       WHERE e.id = $1 AND e.plan_id = $2 AND e.channel_id = $3 AND e.session_id = $4
         AND e.external_message_id = $5 AND o.external_message_id = e.external_message_id
         AND p.action = 'DELETE' AND o.event_type = 'textMessageEvent'
         AND (p.policy_version NOT LIKE 'delete-test-%' OR p.policy_version = $6)
         AND p.policy_version NOT LIKE 'blacklist-%'
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
        execution.external_message_id,
        this.allowedTestPolicyVersion,
      ],
    );
    // Configuration may have changed while the database request was in flight.
    if (!this.isEnabled()) return null;
    const row = result.rows[0];
    return row ? { accountId: row.account_id } : null;
  }
}
