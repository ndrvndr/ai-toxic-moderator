import { aiShadowIdentity, uuid, type AiShadowIdentity } from '@moderator/contracts';
import type { createPool } from '@moderator/persistence';

export type AiShadowModel = Pick<
  AiShadowIdentity,
  'model_id' | 'model_revision' | 'model_variant' | 'adapter_version'
>;
export type AiShadowCandidate = { identity: AiShadowIdentity; text: string };

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

  async next(runId: string): Promise<AiShadowCandidate | null> {
    uuid.parse(runId);
    const result = await this.pool.query<{
      channel_id: string;
      session_id: string;
      observation_id: string;
      run_id: string;
      text: string;
    }>(
      `SELECT o.channel_id, o.session_id, o.id AS observation_id,
              o.first_observed_run_id AS run_id,
              COALESCE(
                o.payload #>> '{snippet,textMessageDetails,messageText}',
                o.payload #>> '{snippet,displayMessage}'
              ) AS text
       FROM youtube_chat_observations o
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
         AND NOT EXISTS (
           SELECT 1 FROM youtube_ai_shadow_results s
           WHERE s.observation_id = o.id
             AND s.model_id = $2 AND s.model_revision = $3
             AND s.model_variant = $4 AND s.adapter_version = $5
         )
       ORDER BY o.received_at, o.id
       LIMIT 1`,
      [
        runId,
        this.model.model_id,
        this.model.model_revision,
        this.model.model_variant,
        this.model.adapter_version,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
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
    return { identity, text: row.text };
  }
}
