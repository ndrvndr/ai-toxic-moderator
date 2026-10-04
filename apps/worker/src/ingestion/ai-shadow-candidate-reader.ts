import {
  aiShadowIdentity,
  customBlacklistSnapshot,
  uuid,
  type AiShadowIdentity,
} from '@moderator/contracts';
import { CustomBlacklistMatcher } from '@moderator/moderation-core';
import type { createPool } from '@moderator/persistence';
import { AI_MAX_QUEUE_AGE_MS } from './ai-backlog-policy';

export type AiShadowModel = Pick<
  AiShadowIdentity,
  'model_id' | 'model_revision' | 'model_variant' | 'adapter_version'
>;
export type AiShadowCandidate = { identity: AiShadowIdentity; text: string; expired: boolean };

const modelSchema = aiShadowIdentity.pick({
  model_id: true,
  model_revision: true,
  model_variant: true,
  adapter_version: true,
});

export class AiShadowCandidateReader {
  private readonly model: AiShadowModel;

  constructor(
    private readonly pool: ReturnType<typeof createPool>,
    model: AiShadowModel,
  ) {
    this.model = modelSchema.parse(model);
  }

  async next(runId: string, signal?: AbortSignal): Promise<AiShadowCandidate | null> {
    uuid.parse(runId);
    let after: { receivedAt: string; id: string } | null = null;
    while (true) {
      if (signal?.aborted) return null;
      const result = await this.pool.query<{
        channel_id: string;
        session_id: string;
        observation_id: string;
        run_id: string;
        text: string;
        snapshot: unknown;
        received_at: string;
        expired: boolean;
      }>(
        `SELECT o.channel_id, o.session_id, o.id AS observation_id,
                o.first_observed_run_id AS run_id,
                COALESCE(
                  o.payload #>> '{snippet,textMessageDetails,messageText}',
                  o.payload #>> '{snippet,displayMessage}'
                ) AS text,
                o.received_at::text AS received_at,
                (clock_timestamp() - o.received_at >= $8::double precision * interval '1 millisecond') AS expired,
                CASE WHEN captured.run_id IS NOT NULL THEN jsonb_build_object(
                  'run_id', captured.run_id, 'channel_id', captured.channel_id,
                  'blacklist_id', captured.blacklist_id, 'blacklist_revision', captured.blacklist_revision,
                  'source', captured.source, 'configuration', captured.configuration
                ) ELSE NULL END AS snapshot
         FROM youtube_chat_observations o
         JOIN monitoring_runs r ON r.id = o.first_observed_run_id
           AND r.channel_id = o.channel_id AND r.session_id = o.session_id
         LEFT JOIN monitoring_blacklist_snapshots captured ON captured.run_id = r.id
           AND captured.channel_id = r.channel_id
         WHERE o.first_observed_run_id = $1
           AND o.event_type = 'textMessageEvent'
           AND COALESCE(
             NULLIF(jsonb_typeof(o.payload #> '{snippet,textMessageDetails,messageText}'), 'null'),
             NULLIF(jsonb_typeof(o.payload #> '{snippet,displayMessage}'), 'null')
           ) = 'string'
           AND COALESCE(
             o.payload #>> '{snippet,textMessageDetails,messageText}',
             o.payload #>> '{snippet,displayMessage}'
           ) ~ '[^[:space:]]'
           AND ($6::timestamptz IS NULL OR (o.received_at, o.id) > ($6::timestamptz, $7::uuid))
           AND NOT EXISTS (
             SELECT 1 FROM youtube_blacklist_decisions bl
             JOIN youtube_chat_classifications c ON c.id = bl.classification_id
               AND c.channel_id = bl.channel_id AND c.session_id = bl.session_id AND c.run_id = bl.run_id
             WHERE c.observation_id = o.id AND bl.run_id = o.first_observed_run_id
               AND bl.channel_id = o.channel_id AND bl.session_id = o.session_id
               AND c.reason_code = 'BLACKLIST_MATCH'
               AND CASE WHEN jsonb_typeof(bl.bundle -> 'matched_rule_ids') = 'array'
                 THEN jsonb_array_length(bl.bundle -> 'matched_rule_ids') > 0 ELSE false END
           )
           AND NOT EXISTS (
             SELECT 1 FROM youtube_ai_shadow_results s
             WHERE s.observation_id = o.id
               AND s.model_id = $2 AND s.model_revision = $3
               AND s.model_variant = $4 AND s.adapter_version = $5
           )
         ORDER BY o.received_at, o.id
         LIMIT 50`,
        [
          runId,
          this.model.model_id,
          this.model.model_revision,
          this.model.model_variant,
          this.model.adapter_version,
          after?.receivedAt ?? null,
          after?.id ?? null,
          AI_MAX_QUEUE_AGE_MS,
        ],
      );
      if (result.rows.length === 0) return null;
      for (const row of result.rows) {
        if (signal?.aborted) return null;
        const identity = aiShadowIdentity.parse({
          channel_id: row.channel_id,
          session_id: row.session_id,
          observation_id: row.observation_id,
          run_id: row.run_id,
          ...this.model,
        });
        if (identity.run_id !== runId || typeof row.text !== 'string' || !row.text.trim()) {
          throw new Error('Invalid AI shadow candidate.');
        }
        const snapshot = customBlacklistSnapshot.parse(row.snapshot);
        if (snapshot.run_id !== identity.run_id || snapshot.channel_id !== identity.channel_id) {
          throw new Error('AI shadow blacklist snapshot belongs to another scope.');
        }
        // Covers legacy/controlled observations without a normal persisted blacklist decision.
        if (new CustomBlacklistMatcher(snapshot.configuration).match(row.text).matched) {
          if (typeof row.received_at !== 'string' || !row.received_at) {
            throw new Error('Invalid AI shadow candidate cursor.');
          }
          const next: { receivedAt: string; id: string } = {
            receivedAt: row.received_at,
            id: identity.observation_id,
          };
          if (after?.receivedAt === next.receivedAt && after.id === next.id) {
            throw new Error('AI shadow candidate cursor did not advance.');
          }
          after = next;
          continue;
        }
        if (typeof row.expired !== 'boolean') throw new Error('Invalid AI queue age.');
        return { identity, text: row.text, expired: row.expired };
      }
    }
  }
}
