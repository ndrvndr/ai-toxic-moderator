import {
  aiShadowIdentity,
  aiShadowResult,
  type AiShadowIdentity,
  type AiShadowResult,
} from '@moderator/contracts';
import type { PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';

export type StoredAiShadowResult = { id: string; result: AiShadowResult };

const columns = `id, channel_id, session_id, observation_id, run_id, model_id,
  model_revision, model_variant, adapter_version, status, rating, severity_score,
  truncated, inference_ms, error_code`;

function readRow(row: Record<string, unknown>): StoredAiShadowResult {
  const { id, ...value } = row;
  if (typeof id !== 'string') throw new Error('Invalid stored AI shadow result ID.');
  return { id, result: aiShadowResult.parse(value) };
}

export class AiShadowStore {
  async find(client: PoolClient, input: AiShadowIdentity): Promise<StoredAiShadowResult | null> {
    const identity = aiShadowIdentity.parse(input);
    const existing = await client.query(
      `SELECT ${columns} FROM youtube_ai_shadow_results
       WHERE channel_id=$1 AND session_id=$2 AND observation_id=$3 AND run_id=$4
         AND model_id=$5 AND model_revision=$6 AND model_variant=$7 AND adapter_version=$8`,
      [
        identity.channel_id,
        identity.session_id,
        identity.observation_id,
        identity.run_id,
        identity.model_id,
        identity.model_revision,
        identity.model_variant,
        identity.adapter_version,
      ],
    );
    return existing.rows[0] ? readRow(existing.rows[0]) : null;
  }

  // Use a caller-owned client/transaction. Inference must finish before entering a database transaction.
  async save(
    client: PoolClient,
    input: AiShadowResult,
  ): Promise<StoredAiShadowResult & { inserted: boolean }> {
    const result = aiShadowResult.parse(input);
    const inserted = await client.query(
      `INSERT INTO youtube_ai_shadow_results (
        ${columns}
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (observation_id, model_id, model_revision, model_variant, adapter_version)
       DO NOTHING RETURNING ${columns}`,
      [
        randomUUID(),
        result.channel_id,
        result.session_id,
        result.observation_id,
        result.run_id,
        result.model_id,
        result.model_revision,
        result.model_variant,
        result.adapter_version,
        result.status,
        result.rating,
        result.severity_score,
        result.truncated,
        result.inference_ms,
        result.error_code,
      ],
    );
    if (inserted.rows[0]) return { ...readRow(inserted.rows[0]), inserted: true };

    const existing = await this.find(client, {
      channel_id: result.channel_id,
      session_id: result.session_id,
      observation_id: result.observation_id,
      run_id: result.run_id,
      model_id: result.model_id,
      model_revision: result.model_revision,
      model_variant: result.model_variant,
      adapter_version: result.adapter_version,
    });
    if (!existing) throw new Error('AI shadow result could not be read after insertion.');
    // Replay returns the persisted result, including terminal errors; it never overwrites history.
    return { ...existing, inserted: false };
  }
}
