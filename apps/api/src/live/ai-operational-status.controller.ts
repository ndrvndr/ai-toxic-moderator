import { Controller, Get, Param, Req } from '@nestjs/common';

import { aiOperationalStatusResponse } from '@moderator/contracts';

import { DatabaseService } from '../database.module';
import { failure, type ApiRequest } from '../http';

const STALE_AFTER_MS = 30_000;

@Controller('v1/channels/:channel_id/ai')
export class AiOperationalStatusController {
  constructor(private readonly database: DatabaseService) {}

  @Get('status')
  async read(@Param('channel_id') channelId: string, @Req() request: ApiRequest) {
    // Recheck membership in the same read that projects the report. The global
    // session/channel guards also reject invalid identifiers and expired sessions.
    const result = await this.database.pool.query<{
      checked_at: Date;
      session_id: string | null;
      run_id: string | null;
      status: string | null;
      reason: string | null;
      error_code: string | null;
      updated_at: Date | null;
      heartbeat_at: Date | null;
    }>(
      `SELECT GREATEST(clock_timestamp(), report.heartbeat_at) AS checked_at,
         report.session_id, report.run_id, report.status, report.reason,
         report.error_code, report.updated_at, report.heartbeat_at
       FROM channel_memberships membership
       LEFT JOIN ai_operational_status report ON report.channel_id = membership.channel_id
       WHERE membership.channel_id = $1 AND membership.account_id = $2
         AND membership.role IN ('OWNER', 'MODERATOR')`,
      [channelId, request.account!.id],
    );
    const row = result.rows[0];
    if (!row) throw failure(403, 'CHANNEL_FORBIDDEN', 'Channel access denied.');

    const report =
      row.status === null
        ? null
        : {
            channel_id: channelId,
            session_id: row.session_id,
            run_id: row.run_id,
            status: row.status,
            reason: row.reason,
            error_code: row.error_code,
            updated_at: row.updated_at!.toISOString(),
            heartbeat_at: row.heartbeat_at!.toISOString(),
          };
    return aiOperationalStatusResponse.parse({
      channel_id: channelId,
      availability:
        report === null
          ? 'UNKNOWN'
          : row.checked_at.getTime() - row.heartbeat_at!.getTime() >= STALE_AFTER_MS
            ? 'STALE'
            : 'ONLINE',
      checked_at: row.checked_at.toISOString(),
      stale_after_ms: STALE_AFTER_MS,
      report,
    });
  }
}
