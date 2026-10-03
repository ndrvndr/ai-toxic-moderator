import { blacklistActionBundle } from '@moderator/contracts';
import { BlacklistActionPlanner } from '@moderator/moderation-core';
import type { PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ActionPlanStore } from './action-plan-store';
import { RunBlacklistMatcher } from './run-blacklist-matcher';

type StoredDecision = {
  id: string;
  bundle: unknown;
  message_plan_id: string | null;
  author_plan_id: string | null;
};

export class BlacklistActionStore {
  constructor(private readonly plans: Pick<ActionPlanStore, 'save'> = new ActionPlanStore()) {}

  /** Requires an existing transaction; savepoint rollback also protects callers that catch errors. */
  async save(client: PoolClient, input: unknown) {
    const bundle = blacklistActionBundle.parse(input);
    const savepoint = `blacklist_${randomUUID().replaceAll('-', '')}`;
    // PostgreSQL rejects SAVEPOINT outside a transaction before any writes occur.
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `blacklist-decision:${bundle.classification_id}:${bundle.policy_version}`,
      ]);
      const result = await client.query<{
        run_id: string;
        external_message_id: string;
        author_channel_id: string | null;
        raw_text: string | null;
        event_type: string;
      }>(
        `SELECT c.run_id, o.external_message_id, o.event_type,
                COALESCE(o.payload #>> '{authorDetails,channelId}',
                         o.payload #>> '{snippet,authorChannelId}') AS author_channel_id,
                CASE WHEN jsonb_typeof(o.payload #> '{snippet,textMessageDetails,messageText}') = 'string'
                  THEN o.payload #>> '{snippet,textMessageDetails,messageText}'
                  WHEN jsonb_typeof(o.payload #> '{snippet,displayMessage}') = 'string'
                  THEN o.payload #>> '{snippet,displayMessage}' ELSE NULL END AS raw_text
         FROM youtube_chat_classifications c
         JOIN youtube_chat_observations o ON o.id = c.observation_id
           AND o.channel_id = c.channel_id AND o.session_id = c.session_id
         WHERE c.id = $1 AND c.channel_id = $2 AND c.session_id = $3`,
        [bundle.classification_id, bundle.channel_id, bundle.session_id],
      );
      const observation = result.rows[0];
      if (
        result.rows.length !== 1 ||
        !observation ||
        observation.run_id !== bundle.run_id ||
        observation.event_type !== 'textMessageEvent' ||
        !observation.raw_text?.trim()
      ) {
        throw new Error(
          'The blacklist classification has no matching text observation in this run scope.',
        );
      }
      const resolved = await new RunBlacklistMatcher().resolve(client, {
        runId: observation.run_id,
        channelId: bundle.channel_id,
        sessionId: bundle.session_id,
      });
      const expected = new BlacklistActionPlanner(resolved.snapshot).plan(
        {
          classification_id: bundle.classification_id,
          channel_id: bundle.channel_id,
          session_id: bundle.session_id,
          run_id: observation.run_id,
          external_message_id: observation.external_message_id,
          author_channel_id: observation.author_channel_id,
        },
        observation.raw_text,
      );
      if (!isDeepStrictEqual(bundle, expected)) {
        throw new Error(
          'The blacklist bundle does not match its captured policy and observed targets.',
        );
      }
      const ids: string[] = [];
      for (const plan of expected.plans) ids.push((await this.plans.save(client, plan)).id);
      const messagePlanId = ids[0] ?? null;
      const authorPlanId = ids[1] ?? null;
      const inserted = await client.query<StoredDecision>(
        `INSERT INTO youtube_blacklist_decisions(
           id, channel_id, session_id, classification_id, run_id, policy_version,
           bundle, message_plan_id, author_plan_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (classification_id, policy_version) DO NOTHING
         RETURNING id, bundle, message_plan_id, author_plan_id`,
        [
          randomUUID(),
          bundle.channel_id,
          bundle.session_id,
          bundle.classification_id,
          bundle.run_id,
          bundle.policy_version,
          JSON.stringify(expected),
          messagePlanId,
          authorPlanId,
        ],
      );
      let stored = inserted.rows[0];
      const reused = !stored;
      if (!stored) {
        stored = (
          await client.query<StoredDecision>(
            `SELECT id, bundle, message_plan_id, author_plan_id FROM youtube_blacklist_decisions
           WHERE classification_id = $1 AND policy_version = $2 AND channel_id = $3 AND session_id = $4`,
            [bundle.classification_id, bundle.policy_version, bundle.channel_id, bundle.session_id],
          )
        ).rows[0];
      }
      if (
        !stored ||
        !isDeepStrictEqual(blacklistActionBundle.parse(stored.bundle), expected) ||
        stored.message_plan_id !== messagePlanId ||
        stored.author_plan_id !== authorPlanId
      ) {
        throw new Error('An incompatible blacklist decision already exists.');
      }
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { id: stored.id, reused, bundle: expected, messagePlanId, authorPlanId };
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
}
