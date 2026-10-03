import { messageInput, type MessageInput } from '@moderator/contracts';
import {
  ModerationPolicy,
  RuleDetectionEngine,
  type ActionPlanner,
  type PolicyDecision,
} from '@moderator/moderation-core';
import type { PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';

import type { ActionPlanStore } from './action-plan-store';

export type ClassificationObservation = {
  channelId: string;
  sessionId: string;
  observationId: string;
  externalMessageId: string;
  runId: string;
  publishedAt: string;
  payload: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function toMessageInput(observation: ClassificationObservation): MessageInput | null {
  const payload = record(observation.payload);
  const snippet = record(payload?.snippet);
  const textDetails = record(snippet?.textMessageDetails);
  const authorDetails = record(payload?.authorDetails);

  const rawText =
    (typeof textDetails?.messageText === 'string'
      ? textDetails.messageText
      : typeof snippet?.displayMessage === 'string'
        ? snippet.displayMessage
        : null) ?? null;

  if (!rawText || rawText.trim().length === 0) {
    return null;
  }

  const authorId =
    typeof authorDetails?.channelId === 'string' ? authorDetails.channelId : 'unknown-author';

  const displayName =
    typeof authorDetails?.displayName === 'string' && authorDetails.displayName.trim().length > 0
      ? authorDetails.displayName
      : 'Unknown viewer';

  return messageInput.parse({
    external_message_id: observation.externalMessageId,
    author_external_id: authorId,
    author_display_name: displayName,
    raw_text: rawText,
    published_at: observation.publishedAt,
  });
}

export class ClassificationStore {
  constructor(
    private readonly engine: Pick<RuleDetectionEngine, 'detect'>,
    private readonly policy: Pick<ModerationPolicy, 'evaluate'>,
    private readonly classifierVersion: string,
    private readonly policyVersion: string,
    private readonly actions?: {
      planner: Pick<ActionPlanner, 'plan'>;
      resolvePlanner?: (
        client: PoolClient,
        observation: ClassificationObservation,
      ) => Promise<Pick<ActionPlanner, 'plan'>>;
      store: Pick<ActionPlanStore, 'save'>;
    },
  ) {}

  async classify(
    client: PoolClient,
    observation: ClassificationObservation,
  ): Promise<{
    classified: boolean;
    decision?: PolicyDecision;
    classificationId?: string;
  }> {
    const input = toMessageInput(observation);

    if (!input) {
      return { classified: false };
    }

    const signals = await this.engine.detect(input);
    const decision = this.policy.evaluate(signals);

    const inserted = await client.query<PolicyDecision & { id: string; run_id: string }>(
      `
        INSERT INTO youtube_chat_classifications(
          id,
          channel_id,
          session_id,
          observation_id,
          run_id,
          classifier_version,
          policy_version,
          outcome,
          primary_category,
          severity,
          reason_code,
          reason,
          signals
        )
        VALUES(
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13::jsonb
        )
        ON CONFLICT(observation_id, classifier_version, policy_version)
        DO NOTHING
        RETURNING id, run_id, outcome, primary_category, severity, reason_code, reason, signals
      `,
      [
        randomUUID(),
        observation.channelId,
        observation.sessionId,
        observation.observationId,
        observation.runId,
        this.classifierVersion,
        this.policyVersion,
        decision.outcome,
        decision.primary_category,
        decision.severity,
        decision.reason_code,
        decision.reason,
        JSON.stringify(decision.signals),
      ],
    );

    let stored = inserted.rows[0];

    if (!stored) {
      const existing = await client.query<PolicyDecision & { id: string; run_id: string }>(
        `
          SELECT id, run_id, outcome, primary_category, severity, reason_code, reason, signals
          FROM youtube_chat_classifications
          WHERE observation_id = $1
            AND classifier_version = $2
            AND policy_version = $3
            AND channel_id = $4
            AND session_id = $5
        `,
        [
          observation.observationId,
          this.classifierVersion,
          this.policyVersion,
          observation.channelId,
          observation.sessionId,
        ],
      );
      stored = existing.rows[0];
    }

    if (!stored) {
      throw new Error('The classification could not be read after insertion.');
    }

    const { id: classificationId, run_id: classificationRunId, ...persistedDecision } = stored;

    // Use the persisted decision on replay, not a newly computed result.
    if (this.actions) {
      // A replay belongs to the original classification run, even after restart.
      const planner = this.actions.resolvePlanner
        ? await this.actions.resolvePlanner(client, { ...observation, runId: classificationRunId })
        : this.actions.planner;
      const plan = planner.plan({
        classification_id: classificationId,
        channel_id: observation.channelId,
        session_id: observation.sessionId,
        external_message_id: observation.externalMessageId,
        author_channel_id: input.author_external_id,
        signals: persistedDecision.signals,
      });
      await this.actions.store.save(client, plan);
    }

    return {
      classified: true,
      classificationId,
      decision: persistedDecision,
    };
  }
}
