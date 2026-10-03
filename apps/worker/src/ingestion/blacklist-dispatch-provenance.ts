import { blacklistActionBundle, customBlacklistSnapshot } from '@moderator/contracts';
import {
  BlacklistActionPlanner,
  CUSTOM_BLACKLIST_MATCHER_VERSION,
} from '@moderator/moderation-core';
import type { createPool } from '@moderator/persistence';
import { isDeepStrictEqual } from 'node:util';

type Slot = 'message' | 'author';

/** Uses the existing scoped plan/classification/observation/run aliases p, c, o, r. */
export function blacklistDispatchAllowedSql(slot: Slot): string {
  const link = slot === 'message' ? 'message_plan_id' : 'author_plan_id';
  return `(
    (p.policy_version NOT LIKE 'blacklist-%' AND c.reason_code <> 'BLACKLIST_MATCH')
    OR (
      p.policy_version LIKE 'blacklist-%'
      AND c.reason_code = 'BLACKLIST_MATCH' AND c.outcome = 'ACTION_REQUIRED'
      AND c.primary_category IS NULL AND c.severity IS NULL AND c.signals = '[]'::jsonb
      AND o.event_type = 'textMessageEvent'
      AND EXISTS (
        SELECT 1 FROM youtube_blacklist_decisions bl
        JOIN monitoring_blacklist_snapshots captured
          ON captured.run_id = bl.run_id AND captured.channel_id = bl.channel_id
        WHERE bl.${link} = p.id AND bl.classification_id = c.id
          AND bl.channel_id = p.channel_id AND bl.session_id = p.session_id
          AND bl.run_id = c.run_id AND bl.run_id = r.id
          AND p.policy_version = bl.policy_version || ':${slot}'
          AND bl.policy_version = 'blacklist-${CUSTOM_BLACKLIST_MATCHER_VERSION}-' || r.id::text
          AND captured.source = 'SAVED' AND captured.configuration -> 'enabled' = 'true'::jsonb
          AND bl.bundle ->> 'matcher_version' = '${CUSTOM_BLACKLIST_MATCHER_VERSION}'
          AND bl.bundle -> 'blacklist_id' = to_jsonb(captured.blacklist_id)
          AND bl.bundle -> 'blacklist_revision' = to_jsonb(captured.blacklist_revision)
      )
    )
  )`;
}

/** Recompute immutable policy evidence; no credentials or provider calls are involved. */
export class BlacklistDispatchProvenance {
  constructor(private readonly pool: ReturnType<typeof createPool>) {}

  async allows(planId: string, channelId: string, sessionId: string, slot: Slot): Promise<boolean> {
    const link = slot === 'message' ? 'message_plan_id' : 'author_plan_id';
    const result = await this.pool.query<{
      bundle: unknown;
      snapshot: unknown;
      run_id: string;
      classification_id: string;
      external_message_id: string;
      author_channel_id: string | null;
      raw_text: string | null;
      stored_plan: unknown;
    }>(
      `SELECT bl.bundle, c.run_id, c.id AS classification_id, o.external_message_id,
        COALESCE(o.payload #>> '{authorDetails,channelId}', o.payload #>> '{snippet,authorChannelId}') AS author_channel_id,
        CASE WHEN jsonb_typeof(o.payload #> '{snippet,textMessageDetails,messageText}') = 'string'
          THEN o.payload #>> '{snippet,textMessageDetails,messageText}'
          WHEN jsonb_typeof(o.payload #> '{snippet,displayMessage}') = 'string'
          THEN o.payload #>> '{snippet,displayMessage}' ELSE NULL END AS raw_text,
        jsonb_build_object('run_id', captured.run_id, 'channel_id', captured.channel_id,
          'blacklist_id', captured.blacklist_id, 'blacklist_revision', captured.blacklist_revision,
          'source', captured.source, 'configuration', captured.configuration) AS snapshot,
        jsonb_build_object('classification_id', p.classification_id, 'channel_id', p.channel_id,
          'session_id', p.session_id, 'policy_version', p.policy_version, 'reason', p.reason,
          'action', p.action) || CASE WHEN p.action = 'DELETE'
            THEN jsonb_build_object('external_message_id', o.external_message_id)
            ELSE jsonb_build_object('author_channel_id',
              COALESCE(o.payload #>> '{authorDetails,channelId}', o.payload #>> '{snippet,authorChannelId}'))
              || CASE WHEN p.action = 'TIMEOUT' THEN jsonb_build_object('duration_seconds', p.duration_seconds)
                 ELSE '{}'::jsonb END END AS stored_plan
       FROM youtube_moderation_action_plans p
       JOIN youtube_chat_classifications c ON c.id = p.classification_id
         AND c.channel_id = p.channel_id AND c.session_id = p.session_id
       JOIN youtube_chat_observations o ON o.id = c.observation_id
         AND o.channel_id = c.channel_id AND o.session_id = c.session_id
       JOIN monitoring_runs r ON r.id = c.run_id
         AND r.channel_id = c.channel_id AND r.session_id = c.session_id
       JOIN youtube_blacklist_decisions bl ON bl.${link} = p.id
         AND bl.classification_id = c.id AND bl.channel_id = c.channel_id AND bl.session_id = c.session_id
       JOIN monitoring_blacklist_snapshots captured ON captured.run_id = c.run_id
         AND captured.channel_id = c.channel_id
       WHERE p.id = $1 AND p.channel_id = $2 AND p.session_id = $3
         AND ${blacklistDispatchAllowedSql(slot)}`,
      [planId, channelId, sessionId],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row?.raw_text?.trim()) return false;
    try {
      const snapshot = customBlacklistSnapshot.parse(row.snapshot);
      const stored = blacklistActionBundle.parse(row.bundle);
      const expected = new BlacklistActionPlanner(snapshot).plan(
        {
          run_id: row.run_id,
          classification_id: row.classification_id,
          channel_id: channelId,
          session_id: sessionId,
          external_message_id: row.external_message_id,
          author_channel_id: row.author_channel_id,
        },
        row.raw_text,
      );
      const selected = expected.plans[slot === 'message' ? 0 : 1];
      return (
        Boolean(selected) &&
        isDeepStrictEqual(stored, expected) &&
        isDeepStrictEqual(row.stored_plan, selected)
      );
    } catch {
      // Invalid or incompatible historical evidence cannot authorize a request.
      return false;
    }
  }
}
