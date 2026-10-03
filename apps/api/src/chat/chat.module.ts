import { chatCursor, chatPage, chatQuery, uuid } from '@moderator/contracts';
import { BAN_DISPATCH_BLOCK_REASON_SQL, transaction } from '@moderator/persistence';
import { Controller, Get, Module, Param, Query, Req } from '@nestjs/common';

import { DatabaseService } from '../database.module';
import { failure, type ApiRequest } from '../http';

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
        ai_shadow: unknown;
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
            shadow.summary AS ai_shadow
          FROM youtube_chat_observations
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
    CASE
      WHEN a.id IS NOT NULL THEN a.status
      WHEN decision.reason = 'MESSAGE_BEFORE_TIMEOUT_END' THEN 'SUPPRESSED'
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
          deletion:
            row.deletion_status === null ? null : { action: 'DELETE', status: row.deletion_status },
          author_action:
            row.author_action_type === null
              ? null
              : {
                  action: row.author_action_type,
                  status: row.author_action_status,
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
