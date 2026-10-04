import {
  aiActionDecision,
  aiActionDecisionSave,
  aiActionDecisionScope,
  aiModerationSettingsSnapshot,
  storedAiActionDecision,
  type AiShadowResult,
  type StoredAiActionDecision,
} from '@moderator/contracts';
import { AiActionPlanner, BlacklistActionPlanner } from '@moderator/moderation-core';
import type { PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';
import { AiShadowStore } from './ai-shadow-store';
import { RunBlacklistMatcher } from './run-blacklist-matcher';

const columns = 'id, model_result_id, decision, blacklist, created_at';
function readRow(row: Record<string, unknown>): StoredAiActionDecision {
  return storedAiActionDecision.parse({
    ...row,
    created_at: (row.created_at as Date).toISOString(),
  });
}

/** Audit persistence only. No executor-visible action plans or provider requests are created. */
export class AiActionDecisionStore {
  async find(client: PoolClient, input: unknown): Promise<StoredAiActionDecision | null> {
    const scope = aiActionDecisionScope.parse(input);
    const result = await client.query(
      `SELECT ${columns} FROM youtube_ai_action_decisions
       WHERE run_id=$1 AND observation_id=$2 AND channel_id=$3 AND session_id=$4`,
      [scope.run_id, scope.observation_id, scope.channel_id, scope.session_id],
    );
    if (!result.rows[0]) return null;
    const stored = readRow(result.rows[0]);
    if (stored.decision.context.classification_id !== scope.classification_id)
      throw new Error(
        'An AI decision already exists for another classification of this observation.',
      );
    return stored;
  }

  /** Caller owns the transaction. First decision wins; replay never resolves a newer model result. */
  async save(client: PoolClient, input: unknown) {
    const { model_result_id: modelResultId, ...scope } = aiActionDecisionSave.parse(input);
    const savepoint = `ai_decision_${randomUUID().replaceAll('-', '')}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `ai-decision:${scope.run_id}:${scope.observation_id}`,
      ]);
      const existing = await this.find(client, scope);
      if (existing) {
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { ...existing, reused: true };
      }
      const observation = (
        await client.query<{
          external_message_id: string;
          author_channel_id: string | null;
          raw_text: string | null;
        }>(
          `SELECT o.external_message_id,
           COALESCE(o.payload #>> '{authorDetails,channelId}', o.payload #>> '{snippet,authorChannelId}') AS author_channel_id,
           CASE WHEN jsonb_typeof(o.payload #> '{snippet,textMessageDetails,messageText}') = 'string'
             THEN o.payload #>> '{snippet,textMessageDetails,messageText}'
             WHEN jsonb_typeof(o.payload #> '{snippet,displayMessage}') = 'string'
             THEN o.payload #>> '{snippet,displayMessage}' ELSE NULL END AS raw_text
         FROM youtube_chat_classifications c
         JOIN youtube_chat_observations o ON o.id=c.observation_id
           AND o.channel_id=c.channel_id AND o.session_id=c.session_id
         WHERE c.id=$1 AND c.channel_id=$2 AND c.session_id=$3 AND c.run_id=$4
           AND c.observation_id=$5 AND o.first_observed_run_id=$4 AND o.event_type='textMessageEvent'`,
          [
            scope.classification_id,
            scope.channel_id,
            scope.session_id,
            scope.run_id,
            scope.observation_id,
          ],
        )
      ).rows[0];
      if (!observation?.raw_text?.trim())
        throw new Error(
          'No matching text observation and classification in this AI decision scope.',
        );
      const captured = (
        await client.query(
          `SELECT run_id, channel_id, settings_id, settings_revision, configuration, source
         FROM monitoring_ai_settings_snapshots WHERE run_id=$1 AND channel_id=$2`,
          [scope.run_id, scope.channel_id],
        )
      ).rows[0];
      const snapshot = aiModerationSettingsSnapshot.parse(captured);
      const resolved = await new RunBlacklistMatcher().resolve(client, {
        runId: scope.run_id,
        channelId: scope.channel_id,
        sessionId: scope.session_id,
      });
      const context = {
        ...scope,
        external_message_id: observation.external_message_id,
        author_channel_id: observation.author_channel_id,
      };
      const { observation_id: ignoredObservation, ...blacklistInput } = context;
      const blacklist = new BlacklistActionPlanner(resolved.snapshot).plan(
        blacklistInput,
        observation.raw_text,
      );
      let output: AiShadowResult | null = null;
      if (modelResultId !== null) {
        const identity = (
          await client.query(
            `SELECT channel_id, session_id, observation_id, run_id, model_id, model_revision, model_variant, adapter_version
           FROM youtube_ai_shadow_results WHERE id=$1 AND channel_id=$2 AND session_id=$3 AND run_id=$4 AND observation_id=$5`,
            [modelResultId, scope.channel_id, scope.session_id, scope.run_id, scope.observation_id],
          )
        ).rows[0];
        if (!identity) throw new Error('Model result does not belong to this AI decision scope.');
        const persisted = await new AiShadowStore().find(client, identity);
        if (!persisted || persisted.id !== modelResultId)
          throw new Error('Persisted model result is unavailable.');
        output = persisted.result;
      }
      const decision = aiActionDecision.parse(
        new AiActionPlanner(snapshot).plan(context, output, blacklist),
      );
      const inserted = await client.query(
        `INSERT INTO youtube_ai_action_decisions(id, channel_id, session_id, run_id, observation_id,
          classification_id, model_result_id, decision, blacklist)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING ${columns}`,
        [
          randomUUID(),
          scope.channel_id,
          scope.session_id,
          scope.run_id,
          scope.observation_id,
          scope.classification_id,
          modelResultId,
          JSON.stringify(decision),
          JSON.stringify(blacklist),
        ],
      );
      const stored = readRow(inserted.rows[0]);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { ...stored, reused: false };
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
}
