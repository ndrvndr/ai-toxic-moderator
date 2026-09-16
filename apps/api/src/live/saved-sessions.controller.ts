import { Controller, Get, Query, Req } from '@nestjs/common';

import { savedSessionsCursor, savedSessionsPage, savedSessionsQuery } from '@moderator/contracts';

import { DatabaseService } from '../database.module';
import { failure, type ApiRequest } from '../http';

@Controller('v1/youtube/sessions')
export class SavedSessionsController {
  constructor(private readonly database: DatabaseService) {}

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
