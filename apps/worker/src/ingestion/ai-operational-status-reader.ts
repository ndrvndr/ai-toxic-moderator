import {
  aiModerationModelIdentity,
  aiModerationSettingsSnapshot,
  aiOperationalErrorCode,
  uuid,
  type AiModerationModelIdentity,
} from '@moderator/contracts';
import type { createPool } from '@moderator/persistence';

import type { AiOperationalStatusUpdate } from './ai-operational-status-store';

type Row = {
  channel_id: string;
  run_id: string | null;
  session_id: string | null;
  status: string | null;
  stop_requested_at: unknown;
  finished_at: unknown;
  session_source: string | null;
  closed_at: unknown;
  chat_ended_at: unknown;
  snapshot: unknown;
  model_status: string | null;
  model_error_code: string | null;
};

/** Diagnostic discovery only; it does not select a run or authorize dispatch. */
export class AiOperationalStatusReader {
  private readonly model: AiModerationModelIdentity | null;

  constructor(
    private readonly pool: Pick<ReturnType<typeof createPool>, 'query'>,
    private readonly enabled: boolean,
    model?: AiModerationModelIdentity,
  ) {
    this.model = enabled ? aiModerationModelIdentity.parse(model) : null;
  }

  async scan(signal: AbortSignal): Promise<AiOperationalStatusUpdate[]> {
    if (signal.aborted) return [];
    if (!this.enabled) {
      const result = await this.pool.query<{ channel_id: string }>(
        'SELECT channel_id FROM youtube_channels ORDER BY channel_id',
      );
      if (signal.aborted) return [];
      return result.rows.map((row) => ({
        channel_id: uuid.parse(row.channel_id).toLowerCase(),
        session_id: null,
        run_id: null,
        status: 'DISABLED',
        reason: 'WORKER_AI_DISABLED',
        error_code: null,
      }));
    }
    const result = await this.pool.query<Row>(
      `SELECT channels.channel_id,r.id AS run_id,r.session_id,r.status,
         r.stop_requested_at,r.finished_at,r.session_source,r.closed_at,r.chat_ended_at,
         to_jsonb(captured)-'captured_at' AS snapshot,
         inference.status AS model_status,inference.error_code AS model_error_code
       FROM youtube_channels channels
       LEFT JOIN (
         SELECT runs.*,s.source AS session_source,s.closed_at,cp.chat_ended_at
         FROM monitoring_runs runs
         JOIN stream_sessions s ON s.id=runs.session_id AND s.channel_id=runs.channel_id
         JOIN youtube_chat_checkpoints cp ON cp.session_id=runs.session_id
         JOIN channel_memberships credential_member ON credential_member.channel_id=runs.channel_id
           AND credential_member.account_id=runs.credential_account_id
         JOIN channel_memberships requester_member ON requester_member.channel_id=runs.channel_id
           AND requester_member.account_id=runs.requested_by_account_id
         WHERE runs.status='RUNNING' AND runs.stop_requested_at IS NULL AND runs.finished_at IS NULL
           AND s.source='YOUTUBE' AND s.closed_at IS NULL AND cp.chat_ended_at IS NULL
           AND credential_member.role IN ('OWNER','MODERATOR')
           AND requester_member.role IN ('OWNER','MODERATOR')
       ) r ON r.channel_id=channels.channel_id
       LEFT JOIN monitoring_ai_settings_snapshots captured
         ON captured.run_id=r.id AND captured.channel_id=r.channel_id
       LEFT JOIN LATERAL (
         SELECT result.status,result.error_code FROM youtube_ai_shadow_results result
         WHERE result.channel_id=r.channel_id AND result.session_id=r.session_id AND result.run_id=r.id
           AND result.model_id=$1 AND result.model_revision=$2
           AND result.model_variant=$3 AND result.adapter_version=$4
           AND result.error_code IS DISTINCT FROM 'INPUT_TOO_LONG'
           AND result.error_code IS DISTINCT FROM 'INPUT_EXPIRED'
         ORDER BY result.created_at DESC,result.id DESC LIMIT 1
       ) inference ON true
       ORDER BY channels.channel_id,r.requested_at DESC,r.id DESC`,
      [
        this.model!.model_id,
        this.model!.model_revision,
        this.model!.model_variant,
        this.model!.adapter_version,
      ],
    );
    if (signal.aborted) return [];
    const channels = new Map<string, { report: AiOperationalStatusUpdate; eligible: boolean }[]>();
    for (const row of result.rows) {
      const channel = uuid.parse(row.channel_id).toLowerCase();
      const states = channels.get(channel) ?? [];
      channels.set(channel, states);
      if (row.run_id === null) continue;
      const run = uuid.parse(row.run_id).toLowerCase();
      const session = uuid.parse(row.session_id).toLowerCase();
      if (
        row.status !== 'RUNNING' ||
        row.stop_requested_at !== null ||
        row.finished_at !== null ||
        row.session_source !== 'YOUTUBE' ||
        row.closed_at !== null ||
        row.chat_ended_at !== null
      )
        throw new Error('Invalid AI status run candidate.');
      const snapshot = aiModerationSettingsSnapshot.parse(row.snapshot);
      if (snapshot.channel_id.toLowerCase() !== channel || snapshot.run_id.toLowerCase() !== run)
        throw new Error('AI status snapshot scope mismatch.');
      const scope = { channel_id: channel, session_id: session, run_id: run, error_code: null };
      if (snapshot.source !== 'SAVED' || !snapshot.configuration.automatic_actions_enabled) {
        states.push({
          report: { ...scope, status: 'DISABLED', reason: 'RUN_AI_DISABLED' },
          eligible: false,
        });
      } else if (
        Object.entries(this.model!).some(
          ([key, value]) =>
            snapshot.configuration.model[key as keyof AiModerationModelIdentity] !== value,
        )
      ) {
        states.push({
          report: { ...scope, status: 'MODEL_MISMATCH', reason: 'CAPTURED_MODEL_MISMATCH' },
          eligible: false,
        });
      } else {
        states.push({
          report:
            row.model_status === 'ERROR'
              ? {
                  ...scope,
                  status: 'ERROR',
                  reason: 'PROCESSING_FAILED',
                  error_code: aiOperationalErrorCode.parse(row.model_error_code),
                }
              : { ...scope, status: 'ACTIVE', reason: 'RUN_SELECTED' },
          eligible: true,
        });
      }
    }
    const eligibleCount = [...channels.values()].flat().filter((state) => state.eligible).length;
    return [...channels].map(([channel, states]) => {
      const eligible = states.find((state) => state.eligible);
      if (eligible && eligibleCount > 1)
        return {
          channel_id: channel,
          session_id: null,
          run_id: null,
          error_code: null,
          status: 'CAPACITY_EXCEEDED' as const,
          reason: 'MULTIPLE_ELIGIBLE_RUNS' as const,
        };
      return (
        eligible?.report ??
        states[0]?.report ?? {
          channel_id: channel,
          session_id: null,
          run_id: null,
          error_code: null,
          status: 'WAITING' as const,
          reason: 'NO_ELIGIBLE_RUN' as const,
        }
      );
    });
  }
}
