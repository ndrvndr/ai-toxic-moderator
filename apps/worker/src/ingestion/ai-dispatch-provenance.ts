import {
  aiModerationSettingsSnapshot,
  aiShadowResult,
  customBlacklistSnapshot,
  moderationActionPlan,
  storedAiActionDecision,
  type StoredAiActionDecision,
} from '@moderator/contracts';
import { AiActionPlanner, BlacklistActionPlanner } from '@moderator/moderation-core';
import type { createPool, PoolClient } from '@moderator/persistence';
import { isDeepStrictEqual } from 'node:util';

type Slot = 'message' | 'author';

/** Built-in and blacklist actions already committed for this observation take priority. */
export const AI_UNOPPOSED_SQL = `NOT EXISTS (
  SELECT 1 FROM youtube_moderation_action_plans prior
  JOIN youtube_chat_classifications prior_c ON prior_c.id=prior.classification_id
    AND prior_c.channel_id=prior.channel_id AND prior_c.session_id=prior.session_id
  WHERE prior_c.observation_id=o.id AND prior.channel_id=o.channel_id
    AND prior.session_id=o.session_id AND prior.action IN ('DELETE','TIMEOUT','BAN')
    AND prior.policy_version NOT LIKE 'ai-%'
)`;

/** Uses the scoped aliases p, c, o, r. Reserved AI policy names always require an audit. */
export function aiDispatchAllowedSql(slot: Slot): string {
  return `(p.policy_version NOT LIKE 'ai-%' OR (
    p.policy_version = 'ai-threshold-1-' || r.id::text || ':${slot}'
    AND o.first_observed_run_id=r.id AND ${AI_UNOPPOSED_SQL}
    AND EXISTS (
      SELECT 1 FROM youtube_ai_action_decisions d
      JOIN monitoring_ai_settings_snapshots captured
        ON captured.run_id=d.run_id AND captured.channel_id=d.channel_id
      JOIN youtube_ai_shadow_results m ON m.id=d.model_result_id
        AND m.run_id=d.run_id AND m.observation_id=d.observation_id
        AND m.channel_id=d.channel_id AND m.session_id=d.session_id
      CROSS JOIN LATERAL jsonb_array_elements(d.decision->'plans') planned
      WHERE d.run_id=r.id AND d.observation_id=o.id AND d.classification_id=c.id
        AND d.channel_id=p.channel_id AND d.session_id=p.session_id
        AND d.decision->>'reason_code'='THRESHOLD_MET'
        AND d.decision->'snapshot'=to_jsonb(captured)-'captured_at'
        AND captured.source='SAVED'
        AND captured.configuration->'automatic_actions_enabled'='true'::jsonb
        AND m.status='SUCCEEDED' AND NOT m.truncated
        AND planned->>'policy_version'=p.policy_version
        AND planned->>'action'=p.action AND planned->>'reason'=p.reason
        AND (planned->>'duration_seconds')::bigint IS NOT DISTINCT FROM p.duration_seconds
    )
  ))`;
}

/** Reconstruct the decision from original targets, captured policies, and persisted inference. */
export async function readAiActionEvidence(
  connection: Pick<PoolClient, 'query'>,
  decisionId: string,
  runId: string,
): Promise<StoredAiActionDecision | null> {
  const result = await connection.query<{
    record: unknown;
    snapshot: unknown;
    blacklist_snapshot: unknown;
    model_output: unknown;
    raw_text: string | null;
    external_message_id: string;
    author_channel_id: string | null;
  }>(
    `SELECT to_jsonb(d)-'channel_id'-'session_id'-'run_id'-'observation_id'-'classification_id' AS record,
      to_jsonb(captured)-'captured_at' AS snapshot,
      to_jsonb(bl)-'captured_at' AS blacklist_snapshot,
      to_jsonb(m)-'id'-'created_at' AS model_output,
      o.external_message_id,
      COALESCE(o.payload #>> '{authorDetails,channelId}', o.payload #>> '{snippet,authorChannelId}') AS author_channel_id,
      CASE WHEN jsonb_typeof(o.payload #> '{snippet,textMessageDetails,messageText}')='string'
        THEN o.payload #>> '{snippet,textMessageDetails,messageText}'
        WHEN jsonb_typeof(o.payload #> '{snippet,displayMessage}')='string'
        THEN o.payload #>> '{snippet,displayMessage}' END AS raw_text
     FROM youtube_ai_action_decisions d
     JOIN youtube_chat_classifications c ON c.id=d.classification_id
       AND c.channel_id=d.channel_id AND c.session_id=d.session_id AND c.run_id=d.run_id
       AND c.observation_id=d.observation_id
     JOIN youtube_chat_observations o ON o.id=d.observation_id
       AND o.channel_id=d.channel_id AND o.session_id=d.session_id AND o.first_observed_run_id=d.run_id
     JOIN monitoring_ai_settings_snapshots captured ON captured.run_id=d.run_id AND captured.channel_id=d.channel_id
     JOIN monitoring_blacklist_snapshots bl ON bl.run_id=d.run_id AND bl.channel_id=d.channel_id
     LEFT JOIN youtube_ai_shadow_results m ON m.id=d.model_result_id
       AND m.run_id=d.run_id AND m.observation_id=d.observation_id
       AND m.channel_id=d.channel_id AND m.session_id=d.session_id
     WHERE d.id=$1 AND d.run_id=$2 AND o.event_type='textMessageEvent'`,
    [decisionId, runId],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row?.raw_text?.trim()) return null;
  try {
    const record = storedAiActionDecision.parse(row.record);
    if (record.id !== decisionId || record.decision.context.run_id !== runId) return null;
    const snapshot = aiModerationSettingsSnapshot.parse(row.snapshot);
    const blacklistSnapshot = customBlacklistSnapshot.parse(row.blacklist_snapshot);
    const { observation_id: ignored, ...context } = record.decision.context;
    if (
      context.external_message_id !== row.external_message_id ||
      context.author_channel_id !== row.author_channel_id
    )
      return null;
    const blacklist = new BlacklistActionPlanner(blacklistSnapshot).plan(context, row.raw_text);
    const output = row.model_output === null ? null : aiShadowResult.parse(row.model_output);
    const expected = new AiActionPlanner(snapshot).plan(record.decision.context, output, blacklist);
    return isDeepStrictEqual(record.blacklist, blacklist) &&
      isDeepStrictEqual(record.decision, expected)
      ? record
      : null;
  } catch {
    return null;
  }
}

export class AiDispatchProvenance {
  constructor(private readonly pool: ReturnType<typeof createPool>) {}

  async allows(
    planId: string,
    channelId: string,
    sessionId: string,
    slot: Slot,
    runId: string,
  ): Promise<boolean> {
    const connection = await this.pool.connect();
    try {
      const result = await connection.query<{ decision_id: string; stored_plan: unknown }>(
        `SELECT d.id AS decision_id,
          jsonb_build_object('classification_id',p.classification_id,'channel_id',p.channel_id,
            'session_id',p.session_id,'policy_version',p.policy_version,'reason',p.reason,'action',p.action)
          || CASE WHEN p.action='DELETE' THEN jsonb_build_object('external_message_id',o.external_message_id)
             ELSE jsonb_build_object('author_channel_id',COALESCE(o.payload #>> '{authorDetails,channelId}',o.payload #>> '{snippet,authorChannelId}'))
               || CASE WHEN p.action='TIMEOUT' THEN jsonb_build_object('duration_seconds',p.duration_seconds) ELSE '{}'::jsonb END END AS stored_plan
         FROM youtube_moderation_action_plans p
         JOIN youtube_chat_classifications c ON c.id=p.classification_id AND c.channel_id=p.channel_id AND c.session_id=p.session_id
         JOIN youtube_chat_observations o ON o.id=c.observation_id AND o.channel_id=c.channel_id AND o.session_id=c.session_id
         JOIN monitoring_runs r ON r.id=c.run_id AND r.channel_id=c.channel_id AND r.session_id=c.session_id
         JOIN youtube_ai_action_decisions d ON d.classification_id=c.id AND d.run_id=r.id AND d.observation_id=o.id
           AND d.channel_id=p.channel_id AND d.session_id=p.session_id
         WHERE p.id=$1 AND p.channel_id=$2 AND p.session_id=$3 AND r.id=$4
           AND ${aiDispatchAllowedSql(slot)}`,
        [planId, channelId, sessionId, runId],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row) return false;
      const evidence = await readAiActionEvidence(connection, row.decision_id, runId);
      if (!evidence) return false;
      const selected = evidence.decision.plans[slot === 'message' ? 0 : 1];
      return (
        Boolean(selected) &&
        isDeepStrictEqual(moderationActionPlan.parse(row.stored_plan), selected)
      );
    } catch {
      return false;
    } finally {
      connection.release();
    }
  }
}
