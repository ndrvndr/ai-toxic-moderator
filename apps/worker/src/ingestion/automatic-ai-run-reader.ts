import {
  aiModerationModelIdentity,
  aiModerationSettingsSnapshot,
  uuid,
  type AiModerationModelIdentity,
  type AiModerationSettingsSnapshot,
} from '@moderator/contracts';
import type { createPool } from '@moderator/persistence';

type SavedSnapshot = Extract<AiModerationSettingsSnapshot, { source: 'SAVED' }>;
type RunRow = {
  run_id: string;
  channel_id: string;
  session_id: string;
  status: string;
  stop_requested_at: string | null;
  finished_at: string | null;
  session_source: string;
  closed_at: string | null;
  chat_ended_at: string | null;
  snapshot: unknown;
};

export type AutomaticAiRunSelection =
  | { kind: 'CANCELLED' | 'IDLE' | 'CAPACITY_EXCEEDED' }
  | {
      kind: 'SELECTED';
      run_id: string;
      channel_id: string;
      session_id: string;
      snapshot: SavedSnapshot;
    };

/** Discover current eligible runs; this reader does not claim work or authorize dispatch. */
export class AutomaticAiRunReader {
  private readonly model: AiModerationModelIdentity;

  constructor(
    private readonly pool: Pick<ReturnType<typeof createPool>, 'query'>,
    model: AiModerationModelIdentity,
  ) {
    this.model = aiModerationModelIdentity.parse(model);
  }

  async next(signal?: AbortSignal): Promise<AutomaticAiRunSelection> {
    if (signal?.aborted) return { kind: 'CANCELLED' };
    const result = await this.pool.query<RunRow>(
      `SELECT r.id AS run_id, r.channel_id, r.session_id, r.status,
        r.stop_requested_at, r.finished_at, s.source AS session_source,
        s.closed_at, cp.chat_ended_at,
        to_jsonb(captured)-'captured_at' AS snapshot
       FROM monitoring_runs r
       JOIN monitoring_ai_settings_snapshots captured
         ON captured.run_id=r.id AND captured.channel_id=r.channel_id
       JOIN stream_sessions s ON s.id=r.session_id AND s.channel_id=r.channel_id
       JOIN youtube_chat_checkpoints cp ON cp.session_id=r.session_id
       JOIN channel_memberships credential_member
         ON credential_member.channel_id=r.channel_id
         AND credential_member.account_id=r.credential_account_id
       JOIN channel_memberships requester_member
         ON requester_member.channel_id=r.channel_id
         AND requester_member.account_id=r.requested_by_account_id
       WHERE r.status='RUNNING' AND r.stop_requested_at IS NULL AND r.finished_at IS NULL
         AND s.source='YOUTUBE' AND s.closed_at IS NULL AND cp.chat_ended_at IS NULL
         AND captured.source='SAVED'
         AND captured.configuration->'automatic_actions_enabled'='true'::jsonb
         AND captured.configuration->'model'=$1::jsonb
         AND credential_member.role IN ('OWNER','MODERATOR')
         AND requester_member.role IN ('OWNER','MODERATOR')
       ORDER BY r.requested_at,r.id LIMIT 2`,
      [JSON.stringify(this.model)],
    );
    if (signal?.aborted) return { kind: 'CANCELLED' };

    const candidates = result.rows.map((row) => {
      const runId = uuid.parse(row.run_id).toLowerCase();
      const channelId = uuid.parse(row.channel_id).toLowerCase();
      const sessionId = uuid.parse(row.session_id).toLowerCase();
      const snapshot = aiModerationSettingsSnapshot.parse(row.snapshot);
      if (
        row.status !== 'RUNNING' ||
        row.stop_requested_at !== null ||
        row.finished_at !== null ||
        row.session_source !== 'YOUTUBE' ||
        row.closed_at !== null ||
        row.chat_ended_at !== null ||
        snapshot.source !== 'SAVED' ||
        snapshot.run_id.toLowerCase() !== runId ||
        snapshot.channel_id.toLowerCase() !== channelId ||
        !snapshot.configuration.automatic_actions_enabled ||
        snapshot.configuration.model.model_id !== this.model.model_id ||
        snapshot.configuration.model.model_revision !== this.model.model_revision ||
        snapshot.configuration.model.model_variant !== this.model.model_variant ||
        snapshot.configuration.model.adapter_version !== this.model.adapter_version
      ) {
        throw new Error('Invalid automatic AI run candidate.');
      }
      return {
        kind: 'SELECTED' as const,
        run_id: runId,
        channel_id: channelId,
        session_id: sessionId,
        snapshot,
      };
    });

    // The portfolio runtime supports one eligible stream; never silently choose among several.
    if (candidates.length > 1) return { kind: 'CAPACITY_EXCEEDED' };
    return candidates[0] ?? { kind: 'IDLE' };
  }
}
