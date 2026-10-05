import { chatCursor, chatPage, chatQuery, uuid } from '@moderator/contracts';
import {
  AI_UNOPPOSED_SQL,
  BAN_DISPATCH_BLOCK_REASON_SQL,
  transaction,
} from '@moderator/persistence';
import { Controller, Get, Module, Param, Query, Req } from '@nestjs/common';

import { DatabaseService } from '../database.module';
import { failure, type ApiRequest } from '../http';
import { summarizeChatAiDecision } from './chat-ai-decision';
import { summarizeChatBlacklist } from './chat-blacklist';

@Controller('v1/channels/:channel_id/sessions/:session_id/chat')
class ChatController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  async list(
    @Param('channel_id') channelId: string,
    @Param('session_id') sessionId: string,
    @Query() raw: unknown,
    @Req() request: ApiRequest,
  ) {
    const parsed = chatQuery.safeParse(raw);

    if (!parsed.success || !uuid.safeParse(sessionId).success) {
      throw failure(
        422,
        'VALIDATION_ERROR',
        'Provide a valid session ID and pagination parameters.',
      );
    }

    const { limit, cursor, outcome: outcomeFilter, category: categoryFilter } = parsed.data;
    let position: { received_at: string; id: string } | null = null;

    if (cursor) {
      try {
        const decoded = chatCursor.parse(
          JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
        );

        if (decoded.channel_id !== channelId || decoded.session_id !== sessionId) {
          throw new Error('Cursor scope mismatch');
        }

        if (decoded.outcome !== outcomeFilter || decoded.category !== categoryFilter) {
          throw new Error('Cursor filter mismatch.');
        }

        position = decoded;
      } catch {
        throw failure(400, 'INVALID_CURSOR', 'The cursor is invalid for this chat session.');
      }
    }

    return transaction(this.database.pool, async (client) => {
      const membership = await client.query<{ role: string }>(
        `
          SELECT role
          FROM channel_memberships
          WHERE channel_id = $1 AND account_id = $2
          FOR SHARE
        `,
        [channelId, request.account!.id],
      );

      if (!['OWNER', 'MODERATOR'].includes(membership.rows[0]?.role ?? '')) {
        throw failure(403, 'CHANNEL_FORBIDDEN', 'You do not have access to this channel.');
      }

      const session = await client.query(
        `
          SELECT session_id
          FROM youtube_broadcasts
          WHERE channel_id = $1 AND session_id = $2
        `,
        [channelId, sessionId],
      );

      if (!session.rows.length) {
        throw failure(404, 'CHAT_SESSION_NOT_FOUND', 'The YouTube chat session was not found.');
      }

      const result = await client.query<{
        id: string;
        external_message_id: string;
        event_type: string;
        published_at: string;
        received_at: string;
        display_text: string | null;
        author_channel_id: string | null;
        author_display_name: string | null;
        evaluation_outcome: 'ALLOW' | 'REVIEW' | 'ACTION_REQUIRED' | 'ERROR' | null;
        evaluation_id: string | null;
        evaluation_run_id: string | null;
        blacklist_bundle: unknown;
        blacklist_snapshot: unknown;
        evaluation_primary_category: string | null;
        evaluation_severity: number | null;
        evaluation_reason_code: string | null;
        evaluation_reason: string | null;
        evaluation_classifier_version: string | null;
        evaluation_policy_version: string | null;
        deletion_status: string | null;
        author_action_type: 'TIMEOUT' | 'BAN' | null;
        author_action_status: string | null;
        author_action_duration: string | null;
        author_action_block_reason: string | null;
        author_action_has_evidence: boolean | null;
        author_action_execution_id: string | null;
        author_action_unban: unknown;
        ai_shadow: unknown;
        first_observed_run_id: string;
        ai_record: unknown;
        ai_built_in_priority: boolean;
        ai_plans_created: boolean;
        ai_run_active: boolean;
      }>(
        `
          SELECT
            id,
            external_message_id,
            event_type,
            to_char(
              published_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS published_at,
            to_char(
              received_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS received_at,
            COALESCE(
              payload #>> '{snippet,textMessageDetails,messageText}',
              payload #>> '{snippet,displayMessage}'
            ) AS display_text,
            COALESCE(
              payload #>> '{authorDetails,channelId}',
              payload #>> '{snippet,authorChannelId}'
            ) AS author_channel_id,
            payload #>> '{authorDetails,displayName}' AS author_display_name,
            evaluation.outcome AS evaluation_outcome,
            evaluation.classification_id AS evaluation_id,
            evaluation.classification_run_id AS evaluation_run_id,
            blacklist.bundle AS blacklist_bundle,
            blacklist.snapshot AS blacklist_snapshot,
            evaluation.primary_category AS evaluation_primary_category,
            evaluation.severity AS evaluation_severity,
            evaluation.reason_code AS evaluation_reason_code,
            evaluation.reason AS evaluation_reason,
            evaluation.classifier_version AS evaluation_classifier_version,
            evaluation.policy_version AS evaluation_policy_version,
            deletion.deletion_status,
            author_action.author_action_type,
            author_action.author_action_status,
            author_action.author_action_duration,
            author_action.author_action_block_reason,
            author_action.author_action_has_evidence,
            author_action.author_action_execution_id,
            author_action.author_action_unban,
            shadow.summary AS ai_shadow,
            first_observed_run_id,
            ai.record AS ai_record,
            ai.built_in_priority AS ai_built_in_priority,
            ai.plans_created AS ai_plans_created,
            ai.run_active AS ai_run_active
          FROM youtube_chat_observations
          LEFT JOIN LATERAL (
            SELECT to_jsonb(d)-'channel_id'-'session_id'-'run_id'-'observation_id'-'classification_id' AS record,
              NOT (${AI_UNOPPOSED_SQL}) AS built_in_priority,
              (r.status='RUNNING' AND r.stop_requested_at IS NULL AND r.finished_at IS NULL) AS run_active,
              NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(d.decision->'plans') planned
                WHERE NOT EXISTS (
                  SELECT 1 FROM youtube_moderation_action_plans p
                  WHERE p.classification_id=d.classification_id AND p.channel_id=d.channel_id
                    AND p.session_id=d.session_id AND p.policy_version=planned->>'policy_version'
                    AND p.action=planned->>'action' AND p.reason=planned->>'reason'
                    AND p.duration_seconds IS NOT DISTINCT FROM (planned->>'duration_seconds')::bigint
                )
              ) AS plans_created
            FROM youtube_ai_action_decisions d
            JOIN monitoring_runs r ON r.id=d.run_id AND r.channel_id=d.channel_id AND r.session_id=d.session_id
            JOIN youtube_chat_observations o ON o.id=d.observation_id AND o.channel_id=d.channel_id
              AND o.session_id=d.session_id AND o.first_observed_run_id=d.run_id
            JOIN youtube_chat_classifications c ON c.id=d.classification_id AND c.run_id=d.run_id
              AND c.observation_id=o.id AND c.channel_id=d.channel_id AND c.session_id=d.session_id
            WHERE d.channel_id=youtube_chat_observations.channel_id
              AND d.session_id=youtube_chat_observations.session_id
              AND d.observation_id=youtube_chat_observations.id
              AND d.run_id=youtube_chat_observations.first_observed_run_id
            LIMIT 1
          ) ai ON true
          LEFT JOIN LATERAL (
            SELECT jsonb_build_object(
              'model_id', s.model_id,
              'model_revision', s.model_revision,
              'model_variant', s.model_variant,
              'adapter_version', s.adapter_version,
              'status', s.status,
              'rating', s.rating,
              'severity_score', s.severity_score,
              'truncated', s.truncated,
              'inference_ms', s.inference_ms,
              'error_code', s.error_code
            ) AS summary
            FROM youtube_ai_shadow_results s
            WHERE s.channel_id = youtube_chat_observations.channel_id
              AND s.session_id = youtube_chat_observations.session_id
              AND s.observation_id = youtube_chat_observations.id
              AND s.run_id = youtube_chat_observations.first_observed_run_id
            ORDER BY s.created_at DESC, s.id DESC
            LIMIT 1
          ) shadow ON true
          LEFT JOIN LATERAL (
            SELECT
              classification.id AS classification_id,
              classification.run_id AS classification_run_id,
              outcome,
              primary_category,
              severity,
              reason_code,
              reason,
              classifier_version,
              policy_version
            FROM youtube_chat_classifications classification
            WHERE classification.channel_id = youtube_chat_observations.channel_id
              AND classification.session_id = youtube_chat_observations.session_id
              AND classification.observation_id = youtube_chat_observations.id
            ORDER BY classification.created_at DESC, classification.id DESC
            LIMIT 1
          ) evaluation ON true
          LEFT JOIN LATERAL (
            SELECT bl.bundle, jsonb_build_object(
              'run_id', captured.run_id, 'channel_id', captured.channel_id,
              'blacklist_id', captured.blacklist_id, 'blacklist_revision', captured.blacklist_revision,
              'source', captured.source, 'configuration', captured.configuration
            ) AS snapshot
            FROM youtube_blacklist_decisions bl
            JOIN monitoring_blacklist_snapshots captured ON captured.run_id = bl.run_id
              AND captured.channel_id = bl.channel_id
            WHERE bl.classification_id = evaluation.classification_id AND bl.run_id = evaluation.classification_run_id
              AND bl.channel_id = youtube_chat_observations.channel_id
              AND bl.session_id = youtube_chat_observations.session_id
            ORDER BY bl.created_at DESC, bl.id DESC
            LIMIT 1
          ) blacklist ON true
          LEFT JOIN LATERAL (
            SELECT COALESCE((
              SELECT a.status
              FROM youtube_delete_executions e
              JOIN youtube_delete_attempts a ON a.execution_id = e.id
              WHERE e.channel_id = youtube_chat_observations.channel_id
                AND e.session_id = youtube_chat_observations.session_id
                AND e.external_message_id = youtube_chat_observations.external_message_id
              ORDER BY a.attempt_number DESC LIMIT 1
            ), 'PENDING') AS deletion_status
            WHERE EXISTS (
              SELECT 1 FROM youtube_moderation_action_plans p
              JOIN youtube_chat_classifications c ON c.id = p.classification_id
                AND c.channel_id = p.channel_id AND c.session_id = p.session_id
              WHERE p.channel_id = youtube_chat_observations.channel_id
                AND p.session_id = youtube_chat_observations.session_id
                AND c.observation_id = youtube_chat_observations.id
                AND p.action = 'DELETE'
            )
          ) deletion ON true
           LEFT JOIN LATERAL (
  SELECT
    e.action AS author_action_type,
    CASE WHEN e.action = 'BAN' AND a.status = 'SUCCEEDED' AND a.ban_id IS NOT NULL
      THEN e.id ELSE NULL END AS author_action_execution_id,
    removal.summary AS author_action_unban,
    CASE
      WHEN a.id IS NOT NULL THEN a.status
      WHEN decision.reason IN ('MESSAGE_BEFORE_TIMEOUT_END', 'MESSAGE_BEFORE_UNBAN') THEN 'SUPPRESSED'
      WHEN decision.reason IS NOT NULL THEN 'BLOCKED'
      ELSE 'PENDING'
    END AS author_action_status,
    e.duration_seconds::text AS author_action_duration,
    CASE
      WHEN a.id IS NULL THEN decision.reason
      ELSE NULL
   END AS author_action_block_reason,
CASE
  WHEN a.status = 'UNKNOWN' THEN EXISTS (
    SELECT 1
    FROM youtube_ban_evidence evidence
    WHERE evidence.attempt_id = a.id
  )
  ELSE NULL
END AS author_action_has_evidence
FROM youtube_ban_executions e
  LEFT JOIN youtube_ban_attempts a ON a.execution_id = e.id
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'id', u.id, 'execution_id', u.execution_id, 'method', u.method, 'status', u.status,
      'requested_at', to_char(u.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'finished_at', to_char(u.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) AS summary
    FROM youtube_unban_requests u
    WHERE u.execution_id = e.id AND u.ban_attempt_id = a.id
      AND u.channel_id = e.channel_id AND u.session_id = e.session_id
    ORDER BY u.requested_at DESC, u.id DESC LIMIT 1
  ) removal ON true
  LEFT JOIN LATERAL (
    SELECT ${BAN_DISPATCH_BLOCK_REASON_SQL} AS reason
    FROM youtube_chat_observations o
    WHERE o.id = e.observation_id
      AND o.channel_id = e.channel_id
      AND o.session_id = e.session_id
      AND a.id IS NULL
  ) decision ON true
  WHERE e.channel_id = youtube_chat_observations.channel_id
    AND e.session_id = youtube_chat_observations.session_id
    AND e.observation_id = youtube_chat_observations.id
) author_action ON true
          WHERE channel_id = $1
            AND session_id = $2
            AND (
              $6::text IS NULL
              OR COALESCE(evaluation.outcome, 'NOT_EVALUATED') = $6::text
            )
            AND (
              $7::text IS NULL
              OR evaluation.primary_category = $7::text
            )
            AND (
              $3::timestamptz IS NULL
              OR (received_at, id) < ($3::timestamptz, $4::uuid)
            )
          ORDER BY received_at DESC, id DESC
          LIMIT $5
        `,
        [
          channelId,
          sessionId,
          position?.received_at ?? null,
          position?.id ?? null,
          limit + 1,
          outcomeFilter ?? null,
          categoryFilter ?? null,
        ],
      );

      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);

      const nextCursor =
        result.rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                channel_id: channelId,
                session_id: sessionId,
                received_at: last.received_at,
                id: last.id,
                outcome: outcomeFilter,
                category: categoryFilter,
              }),
            ).toString('base64url')
          : null;

      return chatPage.parse({
        items: rows.map((row) => ({
          id: row.id,
          external_message_id: row.external_message_id,
          event_type: row.event_type,
          published_at: row.published_at,
          received_at: row.received_at,
          display_text: row.display_text,
          author_channel_id: row.author_channel_id,
          author_display_name: row.author_display_name,
          evaluation_status: row.evaluation_outcome ?? 'NOT_EVALUATED',
          ai_shadow: row.ai_shadow ?? null,
          ai_decision: summarizeChatAiDecision(
            row.ai_record,
            {
              channelId,
              sessionId,
              observationId: row.id,
              runId: row.first_observed_run_id,
              externalMessageId: row.external_message_id,
              authorChannelId: row.author_channel_id,
            },
            {
              builtInPriority: row.ai_built_in_priority,
              plansCreated: row.ai_plans_created,
              runActive: row.ai_run_active,
            },
          ),
          blacklist: summarizeChatBlacklist(row.blacklist_bundle, row.blacklist_snapshot, {
            channelId,
            sessionId,
            classificationId: row.evaluation_id,
            runId: row.evaluation_run_id,
            reasonCode: row.evaluation_reason_code,
          }),
          deletion:
            row.deletion_status === null ? null : { action: 'DELETE', status: row.deletion_status },
          author_action:
            row.author_action_type === null
              ? null
              : {
                  action: row.author_action_type,
                  status: row.author_action_status,
                  ...(row.author_action_execution_id
                    ? {
                        execution_id: row.author_action_execution_id,
                        unban: row.author_action_unban,
                      }
                    : {}),
                  ...(row.author_action_status === 'UNKNOWN'
                    ? {
                        evidence: {
                          matching_event_observed: row.author_action_has_evidence === true,
                          attribution: 'UNPROVEN' as const,
                        },
                      }
                    : {}),
                  ...(row.author_action_block_reason === null
                    ? {}
                    : { block_reason: row.author_action_block_reason }),
                  duration_seconds:
                    row.author_action_duration === null ? null : Number(row.author_action_duration),
                },
          evaluation:
            row.evaluation_outcome === null
              ? null
              : {
                  outcome: row.evaluation_outcome,
                  primary_category: row.evaluation_primary_category,
                  severity: row.evaluation_severity,
                  reason_code: row.evaluation_reason_code!,
                  reason: row.evaluation_reason!,
                  classifier_version: row.evaluation_classifier_version!,
                  policy_version: row.evaluation_policy_version!,
                },
        })),
        next_cursor: nextCursor,
      });
    });
  }
}

@Module({
  controllers: [ChatController],
})
export class ChatModule {}
