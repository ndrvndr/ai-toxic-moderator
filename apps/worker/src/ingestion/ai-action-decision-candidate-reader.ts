import {
  aiActionDecisionSave,
  aiModerationModelIdentity,
  aiModerationSettingsSnapshot,
  customBlacklistSnapshot,
  uuid,
} from '@moderator/contracts';
import { CustomBlacklistMatcher } from '@moderator/moderation-core';
import type { createPool } from '@moderator/persistence';
import type { AiShadowModel } from './ai-shadow-candidate-reader';

export type AiActionDecisionCandidate = ReturnType<typeof aiActionDecisionSave.parse>;

type DecisionCursor = { receivedAt: string; id: string };

type DecisionCandidateRow = {
  run_id: string;
  channel_id: string;
  session_id: string;
  observation_id: string;
  classification_id: string;
  model_result_id: string | null;
  text: string | null;
  received_at: string;
  ai_snapshot: unknown;
  blacklist_snapshot: unknown;
};

/** Finds completed inference and immediate policy skips without creating terminal missing-output decisions. */
export class AiActionDecisionCandidateReader {
  private readonly model: AiShadowModel;

  constructor(
    private readonly pool: ReturnType<typeof createPool>,
    model: AiShadowModel,
  ) {
    this.model = aiModerationModelIdentity.parse(model);
  }

  async next(input: string, signal?: AbortSignal): Promise<AiActionDecisionCandidate | null> {
    const runId = uuid.parse(input).toLowerCase();
    let after: DecisionCursor | null = null;
    while (!signal?.aborted) {
      const result: { rows: DecisionCandidateRow[] } = await this.pool.query<DecisionCandidateRow>(
        `SELECT o.first_observed_run_id AS run_id, o.channel_id, o.session_id,
          o.id AS observation_id, c.id AS classification_id, m.id AS model_result_id,
          o.received_at::text AS received_at,
          CASE WHEN jsonb_typeof(o.payload #> '{snippet,textMessageDetails,messageText}')='string'
            THEN o.payload #>> '{snippet,textMessageDetails,messageText}'
            WHEN jsonb_typeof(o.payload #> '{snippet,displayMessage}')='string'
            THEN o.payload #>> '{snippet,displayMessage}' END AS text,
          to_jsonb(a) - 'captured_at' AS ai_snapshot,
          to_jsonb(b) - 'captured_at' AS blacklist_snapshot
         FROM youtube_chat_observations o
         JOIN monitoring_runs r ON r.id=o.first_observed_run_id
           AND r.channel_id=o.channel_id AND r.session_id=o.session_id
         JOIN LATERAL (
           SELECT id FROM youtube_chat_classifications
           WHERE observation_id=o.id AND channel_id=o.channel_id AND session_id=o.session_id
             AND run_id=o.first_observed_run_id ORDER BY created_at, id LIMIT 1
         ) c ON true
         LEFT JOIN monitoring_ai_settings_snapshots a ON a.run_id=r.id AND a.channel_id=r.channel_id
         LEFT JOIN monitoring_blacklist_snapshots b ON b.run_id=r.id AND b.channel_id=r.channel_id
         LEFT JOIN youtube_ai_shadow_results m ON m.observation_id=o.id AND m.run_id=r.id
           AND m.channel_id=o.channel_id AND m.session_id=o.session_id
           AND m.model_id=$2 AND m.model_revision=$3 AND m.model_variant=$4 AND m.adapter_version=$5
           AND m.status IN ('SUCCEEDED','ERROR')
         WHERE r.id=$1 AND o.event_type='textMessageEvent'
           AND ($6::timestamptz IS NULL OR (o.received_at,o.id)>($6::timestamptz,$7::uuid))
           AND NOT EXISTS (SELECT 1 FROM youtube_ai_action_decisions d WHERE d.run_id=r.id AND d.observation_id=o.id)
         ORDER BY o.received_at,o.id LIMIT 50`,
        [
          runId,
          this.model.model_id,
          this.model.model_revision,
          this.model.model_variant,
          this.model.adapter_version,
          after?.receivedAt ?? null,
          after?.id ?? null,
        ],
      );
      if (signal?.aborted || !result.rows.length) return null;
      for (const row of result.rows) {
        if (signal?.aborted) return null;
        const candidate = aiActionDecisionSave.parse({
          run_id: row.run_id,
          channel_id: row.channel_id,
          session_id: row.session_id,
          observation_id: row.observation_id,
          classification_id: row.classification_id,
          model_result_id: row.model_result_id,
        });
        if (candidate.run_id !== runId)
          throw new Error('AI decision candidate belongs to another run.');
        const ai = aiModerationSettingsSnapshot.parse(row.ai_snapshot);
        const blacklist = customBlacklistSnapshot.parse(row.blacklist_snapshot);
        for (const captured of [ai, blacklist]) {
          if (
            captured.run_id.toLowerCase() !== runId ||
            captured.channel_id.toLowerCase() !== candidate.channel_id
          )
            throw new Error('AI decision candidate has a foreign policy snapshot.');
        }
        if (typeof row.received_at !== 'string' || !row.received_at)
          throw new Error('Invalid AI decision candidate cursor.');
        const next: DecisionCursor = { receivedAt: row.received_at, id: candidate.observation_id };
        if (after !== null && after.receivedAt === next.receivedAt && after.id === next.id)
          throw new Error('AI decision candidate cursor did not advance.');
        after = next;
        if (typeof row.text !== 'string' || !row.text.trim()) continue;
        const matches = new CustomBlacklistMatcher(blacklist.configuration).match(row.text).matched;
        // A normal enabled AI policy waits for a persisted terminal result. Pending inference is not missing output.
        if (
          !matches &&
          ai.configuration?.automatic_actions_enabled &&
          candidate.model_result_id === null
        )
          continue;
        return candidate;
      }
    }
    return null;
  }
}
