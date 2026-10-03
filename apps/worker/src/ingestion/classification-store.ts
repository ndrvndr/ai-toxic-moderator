import { messageInput, type MessageInput } from '@moderator/contracts';
import {
  BlacklistActionPlanner,
  ModerationPolicy,
  RuleDetectionEngine,
  type ActionPlanner,
  type PolicyDecision,
} from '@moderator/moderation-core';
import type { PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';

import type { ActionPlanStore } from './action-plan-store';
import type { BlacklistActionStore } from './blacklist-action-store';
import type { RunBlacklistMatcher } from './run-blacklist-matcher';

type ClassificationDecision =
  | PolicyDecision
  | {
      outcome: 'ACTION_REQUIRED';
      primary_category: null;
      severity: null;
      reason_code: 'BLACKLIST_MATCH';
      reason: string;
      signals: PolicyDecision['signals'];
    };
type StoredClassification = ClassificationDecision & { id: string; run_id: string };

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
  if (snippet?.type !== undefined && snippet.type !== 'textMessageEvent') {
    return null;
  }

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
    typeof authorDetails?.channelId === 'string'
      ? authorDetails.channelId
      : typeof snippet?.authorChannelId === 'string'
        ? snippet.authorChannelId
        : 'unknown-author';

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
    private readonly blacklist?: {
      resolver: Pick<RunBlacklistMatcher, 'resolve'>;
      store: Pick<BlacklistActionStore, 'save'>;
    },
  ) {}

  async classify(
    client: PoolClient,
    observation: ClassificationObservation,
  ): Promise<{
    classified: boolean;
    decision?: ClassificationDecision;
    classificationId?: string;
  }> {
    const input = toMessageInput(observation);

    if (!input) {
      return { classified: false };
    }

    const readExisting = async () => {
      const result = await client.query<StoredClassification>(
        `SELECT id, run_id, outcome, primary_category, severity, reason_code, reason, signals
         FROM youtube_chat_classifications
         WHERE observation_id = $1 AND classifier_version = $2 AND policy_version = $3
           AND channel_id = $4 AND session_id = $5`,
        [
          observation.observationId,
          this.classifierVersion,
          this.policyVersion,
          observation.channelId,
          observation.sessionId,
        ],
      );
      return result.rows[0];
    };
    let stored = this.blacklist ? await readExisting() : undefined;
    let resolved = this.blacklist
      ? await this.blacklist.resolver.resolve(client, {
          runId: stored?.run_id ?? observation.runId,
          channelId: observation.channelId,
          sessionId: observation.sessionId,
        })
      : undefined;
    const match = resolved?.matcher.match(input.raw_text);
    const decision: ClassificationDecision =
      stored ??
      (match?.matched
        ? {
            outcome: 'ACTION_REQUIRED',
            primary_category: null,
            severity: null,
            reason_code: 'BLACKLIST_MATCH',
            reason: `The message matched blacklist entry ${match.selected_rule_id}.`,
            signals: [],
          }
        : this.policy.evaluate(await this.engine.detect(input)));

    if (!stored) {
      const inserted = await client.query<StoredClassification>(
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

      stored = inserted.rows[0];

      if (!stored) stored = await readExisting();
    }

    if (!stored) {
      throw new Error('The classification could not be read after insertion.');
    }

    const { id: classificationId, run_id: classificationRunId, ...persistedDecision } = stored;
    let blacklistMatched = false;
    if (this.blacklist && resolved) {
      // A concurrent insertion can select an earlier run; always use its snapshot.
      if (resolved.snapshot.run_id !== classificationRunId) {
        resolved = await this.blacklist.resolver.resolve(client, {
          runId: classificationRunId,
          channelId: observation.channelId,
          sessionId: observation.sessionId,
        });
      }
      const bundle = new BlacklistActionPlanner(resolved.snapshot).plan(
        {
          run_id: classificationRunId,
          channel_id: observation.channelId,
          session_id: observation.sessionId,
          classification_id: classificationId,
          external_message_id: observation.externalMessageId,
          author_channel_id:
            input.author_external_id === 'unknown-author' ? null : input.author_external_id,
        },
        input.raw_text,
      );
      await this.blacklist.store.save(client, bundle);
      blacklistMatched = bundle.matched_rule_ids.length > 0;
    }

    // Use the persisted decision on replay, not a newly computed result.
    if (this.actions && !blacklistMatched) {
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
