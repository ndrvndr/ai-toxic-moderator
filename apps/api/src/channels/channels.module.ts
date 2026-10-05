import { Controller, Get, Module, Param, Query } from '@nestjs/common';

import { sessionCursor, sessionsPage, sessionsQuery } from '@moderator/contracts';

import { DatabaseService } from '../database.module';
import { failure } from '../http';

@Controller('v1/channels/:channel_id/sessions')
class SessionsController {
  constructor(private readonly database: DatabaseService) {}
  @Get()
  async list(@Param('channel_id') channelId: string, @Query() raw: unknown) {
    const parsed = sessionsQuery.safeParse(raw);
    if (!parsed.success) throw failure(422, 'VALIDATION_ERROR', 'The session filter is invalid.');
    const { limit, cursor } = parsed.data;
    let position: { created_at: string; id: string } | null = null;
    if (cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error('format');
        const decoded = sessionCursor.parse(
          JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
        );
        if (decoded.channel_id !== channelId) throw Error('scope');
        position = decoded;
      } catch {
        throw failure(400, 'INVALID_CURSOR', 'The session cursor is invalid for this channel.');
      }
    }
    const result = await this.database.pool.query(
      `
      SELECT s.id,s.label,s.source,s.created_at,s.closed_at,r.id AS primary_run_id,
        to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM stream_sessions s JOIN evaluation_runs r ON r.channel_id=s.channel_id AND r.session_id=s.id AND r.kind='PRIMARY'
      WHERE s.channel_id=$1 AND ($2::timestamptz IS NULL OR (s.created_at,s.id)<($2::timestamptz,$3::uuid))
      ORDER BY s.created_at DESC,s.id DESC LIMIT $4`,
      [channelId, position?.created_at ?? null, position?.id ?? null, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    const next =
      result.rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              channel_id: channelId,
              created_at: last.cursor_created_at,
              id: last.id,
            }),
          ).toString('base64url')
        : null;
    return sessionsPage.parse({
      items: rows.map((row) => ({
        id: row.id,
        label: row.label,
        source: row.source,
        created_at: row.created_at.toISOString(),
        closed_at: row.closed_at?.toISOString() ?? null,
        primary_run_id: row.primary_run_id,
      })),
      next_cursor: next,
    });
  }
}
@Module({ controllers: [SessionsController] })
export class ChannelsModule {}
