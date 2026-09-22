import { moderationActionPlan, type ModerationActionPlan } from '@moderator/contracts';
import type { PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';

type StoredActionPlan = {
  id: string;
  channel_id: string;
  session_id: string;
  classification_id: string;
  policy_version: string;
  action: ModerationActionPlan['action'];
  duration_seconds: string | null;
  reason: string;
};

export class ActionPlanStore {
  async save(client: PoolClient, input: unknown) {
    const plan = moderationActionPlan.parse(input);

    const source = await client.query<{
      external_message_id: string;
      author_channel_id: string | null;
    }>(
      `
        SELECT
          observation.external_message_id,
          COALESCE(
            observation.payload #>> '{authorDetails,channelId}',
            observation.payload #>> '{snippet,authorChannelId}'
          ) AS author_channel_id
        FROM youtube_chat_classifications classification
        JOIN youtube_chat_observations observation
          ON observation.channel_id = classification.channel_id
          AND observation.session_id = classification.session_id
          AND observation.id = classification.observation_id
        WHERE classification.id = $1
          AND classification.channel_id = $2
          AND classification.session_id = $3
      `,
      [plan.classification_id, plan.channel_id, plan.session_id],
    );

    const observation = source.rows[0];

    if (!observation) {
      throw new Error('The classification was not found in the requested scope.');
    }

    if (plan.action === 'DELETE' && plan.external_message_id !== observation.external_message_id) {
      throw new Error('The deletion target does not match the classified message.');
    }

    if (
      (plan.action === 'TIMEOUT' || plan.action === 'BAN') &&
      plan.author_channel_id !== observation.author_channel_id
    ) {
      throw new Error('The moderation target does not match the classified author.');
    }

    const inserted = await client.query<StoredActionPlan>(
      `
        INSERT INTO youtube_moderation_action_plans(
          id,
          channel_id,
          session_id,
          classification_id,
          policy_version,
          action,
          duration_seconds,
          reason
        )
        VALUES($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(classification_id, policy_version) DO NOTHING
        RETURNING
          id,
          channel_id,
          session_id,
          classification_id,
          policy_version,
          action,
          duration_seconds::text,
          reason
      `,
      [
        randomUUID(),
        plan.channel_id,
        plan.session_id,
        plan.classification_id,
        plan.policy_version,
        plan.action,
        plan.action === 'TIMEOUT' ? plan.duration_seconds : null,
        plan.reason,
      ],
    );

    let stored = inserted.rows[0];
    const reused = stored === undefined;

    if (!stored) {
      const existing = await client.query<StoredActionPlan>(
        `
          SELECT
            id,
            channel_id,
            session_id,
            classification_id,
            policy_version,
            action,
            duration_seconds::text,
            reason
          FROM youtube_moderation_action_plans
          WHERE classification_id = $1
            AND policy_version = $2
            AND channel_id = $3
            AND session_id = $4
        `,
        [plan.classification_id, plan.policy_version, plan.channel_id, plan.session_id],
      );

      stored = existing.rows[0];
    }

    if (!stored) {
      throw new Error('The action plan could not be read after insertion.');
    }

    const expectedDuration = plan.action === 'TIMEOUT' ? String(plan.duration_seconds) : null;

    if (
      stored.action !== plan.action ||
      stored.duration_seconds !== expectedDuration ||
      stored.reason !== plan.reason
    ) {
      throw new Error('An incompatible plan already exists for this policy version.');
    }

    return {
      id: stored.id,
      reused,
      plan,
    };
  }
}
