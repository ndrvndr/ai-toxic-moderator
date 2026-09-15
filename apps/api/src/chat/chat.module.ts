import { chatCursor, chatPage, chatQuery, uuid } from '@moderator/contracts';
import { transaction } from '@moderator/persistence';
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

    const { limit, cursor } = parsed.data;
    let position: { received_at: string; id: string } | null = null;

    if (cursor) {
      try {
        const decoded = chatCursor.parse(
          JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
        );

        if (decoded.channel_id !== channelId || decoded.session_id !== sessionId) {
          throw new Error('Cursor scope mismatch');
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
            payload #>> '{authorDetails,displayName}' AS author_display_name
          FROM youtube_chat_observations
          WHERE channel_id = $1
            AND session_id = $2
            AND (
              $3::timestamptz IS NULL
              OR (received_at, id) < ($3::timestamptz, $4::uuid)
            )
          ORDER BY received_at DESC, id DESC
          LIMIT $5
        `,
        [channelId, sessionId, position?.received_at ?? null, position?.id ?? null, limit + 1],
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
              }),
            ).toString('base64url')
          : null;

      return chatPage.parse({
        items: rows.map((row) => ({
          ...row,
          evaluation_status: 'NOT_EVALUATED',
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
