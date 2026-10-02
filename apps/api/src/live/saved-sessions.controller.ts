import { Controller, Get, Param, Query, Req } from '@nestjs/common';

import {
  historyStatistics,
  savedSession,
  savedSessionsCursor,
  savedSessionsPage,
  savedSessionsQuery,
  uuid,
} from '@moderator/contracts';

import { DatabaseService } from '../database.module';
import { failure, type ApiRequest } from '../http';

@Controller('v1/youtube/sessions')
export class SavedSessionsController {
  constructor(private readonly database: DatabaseService) {}

  @Get(':session_id/statistics')
  async statistics(@Param('session_id') sessionId: string, @Req() request: ApiRequest) {
    if (!uuid.safeParse(sessionId).success) {
      throw failure(422, 'VALIDATION_ERROR', 'Provide a valid session ID.');
    }

    const result = await this.database.pool.query<{
      session_id: string;
      total_messages: string;
      allowed_messages: string;
      flagged_messages: string;
      error_messages: string;
      unevaluated_messages: string;
      flagged_reasons: unknown;
    }>(
      `
        WITH accessible_session AS (
          SELECT s.id, s.channel_id
          FROM stream_sessions s
          JOIN youtube_broadcasts b
            ON b.session_id = s.id
            AND b.channel_id = s.channel_id
          JOIN channel_memberships membership
            ON membership.channel_id = s.channel_id
            AND membership.account_id = $1
            AND membership.role IN ('OWNER', 'MODERATOR')
          WHERE s.id = $2
        ),
        latest_observations AS (
          SELECT DISTINCT ON (o.external_message_id)
            o.id,
            o.channel_id,
            o.session_id,
            o.event_type
          FROM youtube_chat_observations o
          JOIN accessible_session s
            ON s.id = o.session_id
            AND s.channel_id = o.channel_id
          ORDER BY
            o.external_message_id,
            o.received_at DESC,
            o.id DESC
        ),
        evaluated_messages AS (
          SELECT
  o.id,
  evaluation.outcome,
  evaluation.primary_category,
  evaluation.reason_code
          FROM latest_observations o
          LEFT JOIN LATERAL (
            SELECT c.outcome, c.primary_category, c.reason_code
            FROM youtube_chat_classifications c
            WHERE c.channel_id = o.channel_id
              AND c.session_id = o.session_id
              AND c.observation_id = o.id
            ORDER BY c.created_at DESC, c.id DESC
            LIMIT 1
          ) evaluation ON true
          WHERE o.event_type = 'textMessageEvent'
        )
        SELECT
          s.id AS session_id,
          counts.total_messages,
          counts.allowed_messages,
          counts.flagged_messages,
          counts.error_messages,
counts.unevaluated_messages,
COALESCE(
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'category', reasons.primary_category,
        'reason_code', reasons.reason_code,
        'message_count', reasons.message_count
      )
      ORDER BY
        reasons.message_count DESC,
        reasons.primary_category,
        reasons.reason_code
    )
    FROM (
      SELECT
        primary_category,
        reason_code,
        count(*) AS message_count
      FROM evaluated_messages
      WHERE outcome IN ('REVIEW', 'ACTION_REQUIRED')
      GROUP BY primary_category, reason_code
    ) reasons
  ),
  '[]'::jsonb
) AS flagged_reasons
        FROM accessible_session s
        CROSS JOIN (
          SELECT
            count(*)::text AS total_messages,
            (count(*) FILTER (
              WHERE outcome = 'ALLOW'
            ))::text AS allowed_messages,
            (count(*) FILTER (
              WHERE outcome IN ('REVIEW', 'ACTION_REQUIRED')
            ))::text AS flagged_messages,
            (count(*) FILTER (
              WHERE outcome = 'ERROR'
            ))::text AS error_messages,
            (count(*) FILTER (
              WHERE outcome IS NULL
            ))::text AS unevaluated_messages
          FROM evaluated_messages
        ) counts
      `,
      [request.account!.id, sessionId],
    );

    const row = result.rows[0];

    if (!row) {
      throw failure(
        404,
        'SAVED_SESSION_NOT_FOUND',
        'The saved session was not found or is not accessible.',
      );
    }

    return historyStatistics.parse({
      session_id: row.session_id,
      total_messages: Number(row.total_messages),
      allowed_messages: Number(row.allowed_messages),
      flagged_messages: Number(row.flagged_messages),
      error_messages: Number(row.error_messages),
      unevaluated_messages: Number(row.unevaluated_messages),
      flagged_reasons: row.flagged_reasons,
    });
  }

  @Get(':session_id')
  async detail(@Param('session_id') sessionId: string, @Req() request: ApiRequest) {
    if (!uuid.safeParse(sessionId).success) {
      throw failure(422, 'VALIDATION_ERROR', 'Provide a valid session ID.');
    }

    const result = await this.database.pool.query(
      `
        SELECT
          s.id AS session_id,
          s.channel_id,
          b.youtube_broadcast_id,
          s.label AS title,
          to_char(
            s.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS created_at,
          latest.status AS latest_status
        FROM stream_sessions s
        JOIN youtube_broadcasts b
          ON b.session_id = s.id
          AND b.channel_id = s.channel_id
        JOIN channel_memberships membership
          ON membership.channel_id = s.channel_id
          AND membership.account_id = $1
          AND membership.role IN ('OWNER', 'MODERATOR')
        LEFT JOIN LATERAL (
          SELECT status
          FROM monitoring_runs
          WHERE channel_id = s.channel_id
            AND session_id = s.id
          ORDER BY requested_at DESC, id DESC
          LIMIT 1
        ) latest ON true
        WHERE s.id = $2
      `,
      [request.account!.id, sessionId],
    );

    const session = result.rows[0];

    if (!session) {
      throw failure(
        404,
        'SAVED_SESSION_NOT_FOUND',
        'The saved session was not found or is not accessible.',
      );
    }

    return savedSession.parse(session);
  }

  @Get()
  async list(@Query() raw: unknown, @Req() request: ApiRequest) {
    const parsed = savedSessionsQuery.safeParse(raw);

    if (!parsed.success) {
      throw failure(422, 'VALIDATION_ERROR', 'Provide valid session pagination parameters.');
    }

    const accountId = request.account!.id;
    const { limit, cursor } = parsed.data;
    let position: { created_at: string; session_id: string } | null = null;

    if (cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
          throw new Error('Invalid cursor encoding.');
        }

        const decoded = savedSessionsCursor.parse(
          JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
        );

        if (decoded.account_id !== accountId) {
          throw new Error('Cursor account mismatch.');
        }

        position = decoded;
      } catch {
        throw failure(400, 'INVALID_CURSOR', 'The saved session cursor is invalid.');
      }
    }

    const result = await this.database.pool.query<{
      session_id: string;
      channel_id: string;
      youtube_broadcast_id: string;
      title: string;
      created_at: string;
      latest_status: string | null;
    }>(
      `
        SELECT
          s.id AS session_id,
          s.channel_id,
          b.youtube_broadcast_id,
          s.label AS title,
          to_char(
            s.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS created_at,
          latest.status AS latest_status
        FROM stream_sessions s
        JOIN youtube_broadcasts b
          ON b.session_id = s.id
          AND b.channel_id = s.channel_id
        JOIN channel_memberships membership
          ON membership.channel_id = s.channel_id
          AND membership.account_id = $1
          AND membership.role IN ('OWNER', 'MODERATOR')
        LEFT JOIN LATERAL (
          SELECT status
          FROM monitoring_runs
          WHERE channel_id = s.channel_id
            AND session_id = s.id
          ORDER BY requested_at DESC, id DESC
          LIMIT 1
        ) latest ON true
        WHERE (
          $2::timestamptz IS NULL
          OR (s.created_at, s.id) < ($2::timestamptz, $3::uuid)
        )
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $4
      `,
      [accountId, position?.created_at ?? null, position?.session_id ?? null, limit + 1],
    );

    const items = result.rows.slice(0, limit);
    const last = items.at(-1);

    const nextCursor =
      result.rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              account_id: accountId,
              created_at: last.created_at,
              session_id: last.session_id,
            }),
          ).toString('base64url')
        : null;

    return savedSessionsPage.parse({
      items,
      next_cursor: nextCursor,
    });
  }
}
