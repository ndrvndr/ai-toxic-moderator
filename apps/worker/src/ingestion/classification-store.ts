import { messageInput, type MessageInput } from '@moderator/contracts';
import {
  ModerationPolicy,
  RuleDetectionEngine,
  type PolicyDecision,
} from '@moderator/moderation-core';
import type { PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';

export type ClassificationObservation = {
  channelId: string;
  sessionId: string;
  observationId: string;
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
    external_message_id: observation.observationId,
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
  ) {}

  async classify(
    client: PoolClient,
    observation: ClassificationObservation,
  ): Promise<{
    classified: boolean;
    decision?: PolicyDecision;
  }> {
    const input = toMessageInput(observation);

    if (!input) {
      return { classified: false };
    }

    const signals = await this.engine.detect(input);
    const decision = this.policy.evaluate(signals);

    await client.query(
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

    return {
      classified: true,
      decision,
    };
  }
}
