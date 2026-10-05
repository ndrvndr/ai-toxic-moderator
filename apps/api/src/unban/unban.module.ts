import type { AppConfig } from '@moderator/config';
import {
  unbanHistory,
  unbanRequest,
  unbanResponse,
  unbanSummary,
  uuid,
  type UnbanRequest,
} from '@moderator/contracts';
import { appendLiveEvent, transaction, type PoolClient } from '@moderator/persistence';
import {
  GoogleProvider,
  GoogleTokenStore,
  YoutubeUnbanAdapter,
  type YoutubeUnbanInput,
  type YoutubeUnbanResult,
} from '@moderator/provider-adapters';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, DatabaseService } from '../database.module';
import { failure, type ApiRequest } from '../http';

export const UNBAN_PROVIDER = Symbol('UNBAN_PROVIDER');
export type UnbanProvider = {
  accessToken(accountId: string): Promise<string>;
  removeBan(input: YoutubeUnbanInput): Promise<YoutubeUnbanResult>;
};
type Scope = {
  accountId: string;
  sessionHash: string;
  channelId: string;
  sessionId: string;
  executionId: string;
};
type Target = { attempt_id: string; ban_id: string; credential_account_id: string; run_id: string };
type RecordRow = {
  id: string;
  request_id: string;
  execution_id: string;
  channel_id: string;
  session_id: string;
  method: string;
  status: string;
  requested_at: Date;
  finished_at: Date | null;
};
const fields =
  'id,request_id,execution_id,channel_id,session_id,method,status,requested_at,finished_at';
function summary(row: RecordRow) {
  return unbanSummary.parse({
    id: row.id,
    execution_id: row.execution_id,
    method: row.method,
    status: row.status,
    requested_at: row.requested_at.toISOString(),
    finished_at: row.finished_at?.toISOString() ?? null,
  });
}

@Injectable()
export class UnbanService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(UNBAN_PROVIDER) private readonly provider: UnbanProvider,
  ) {}

  private async authorize(client: PoolClient, scope: Scope): Promise<Target> {
    for (const id of [scope.channelId, scope.sessionId, scope.executionId])
      if (!uuid.safeParse(id).success)
        throw failure(422, 'VALIDATION_ERROR', 'Provide valid channel, session and execution IDs.');
    const session = await client.query(
      `SELECT token_hash FROM dashboard_sessions WHERE token_hash=$1 AND account_id=$2 AND expires_at>clock_timestamp()
       AND (($3 AND auth_provider='google') OR ($4 AND auth_provider='development'))`,
      [
        scope.sessionHash,
        scope.accountId,
        this.config.GOOGLE_AUTH_ENABLED,
        this.config.DEV_AUTH_ENABLED,
      ],
    );
    if (!session.rows.length)
      throw failure(401, 'UNAUTHENTICATED', 'Your session has ended. Please sign in again.');
    const member = await client.query(
      'SELECT role FROM channel_memberships WHERE channel_id=$1 AND account_id=$2 FOR SHARE',
      [scope.channelId, scope.accountId],
    );
    if (member.rows[0]?.role !== 'OWNER')
      throw failure(403, 'CHANNEL_FORBIDDEN', 'Only the channel owner can remove a ban.');
    const target = await client.query<Target>(
      `SELECT a.id AS attempt_id,a.ban_id,r.credential_account_id,c.run_id
       FROM youtube_ban_executions e JOIN youtube_ban_attempts a ON a.execution_id=e.id
       JOIN youtube_moderation_action_plans p ON p.id=e.plan_id AND p.channel_id=e.channel_id AND p.session_id=e.session_id
       JOIN youtube_chat_classifications c ON c.id=p.classification_id AND c.channel_id=p.channel_id AND c.session_id=p.session_id
       JOIN monitoring_runs r ON r.id=c.run_id AND r.channel_id=c.channel_id AND r.session_id=c.session_id
       WHERE e.id=$1 AND e.channel_id=$2 AND e.session_id=$3 AND e.action='BAN' AND a.status='SUCCEEDED' AND a.ban_id IS NOT NULL`,
      [scope.executionId, scope.channelId, scope.sessionId],
    );
    if (!target.rows[0])
      throw failure(
        404,
        'BAN_NOT_FOUND',
        'A confirmed permanent ban was not found in this session.',
      );
    return target.rows[0];
  }

  private publish(client: PoolClient, scope: Scope, target: Target) {
    return appendLiveEvent(client, {
      channelId: scope.channelId,
      sessionId: scope.sessionId,
      runId: target.run_id,
      type: 'chat.updated',
    });
  }

  private async recover(client: PoolClient, scope: Scope, target: Target) {
    const expired = await client.query(
      `UPDATE youtube_unban_requests SET status='UNKNOWN',error_code='EXECUTION_DEADLINE_EXCEEDED',finished_at=GREATEST(clock_timestamp(),requested_at)
       WHERE execution_id=$1 AND channel_id=$2 AND session_id=$3 AND status='DISPATCHED' AND deadline_at<=clock_timestamp() RETURNING id`,
      [scope.executionId, scope.channelId, scope.sessionId],
    );
    if (expired.rows.length) await this.publish(client, scope, target);
  }

  async history(scope: Scope) {
    return transaction(this.database.pool, async (client) => {
      const target = await this.authorize(client, scope);
      await this.recover(client, scope, target);
      const rows = await client.query<RecordRow>(
        `SELECT ${fields} FROM youtube_unban_requests WHERE execution_id=$1 AND channel_id=$2 AND session_id=$3 ORDER BY requested_at DESC,id DESC LIMIT 50`,
        [scope.executionId, scope.channelId, scope.sessionId],
      );
      return unbanHistory.parse({ items: rows.rows.map(summary) });
    });
  }

  async request(scope: Scope, raw: unknown) {
    const parsed = unbanRequest.safeParse(raw);
    if (!parsed.success)
      throw failure(
        422,
        'VALIDATION_ERROR',
        'Choose an unban method and provide a valid request ID. Studio removal requires explicit confirmation.',
      );
    const input = parsed.data;
    const prepared = await transaction(this.database.pool, async (client) => {
      const target = await this.authorize(client, scope);
      // Account/request identity serializes replay, including attempts to change its target.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify(['unban-request', scope.accountId, input.request_id]),
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify(['unban-attempt', target.attempt_id]),
      ]);
      await this.recover(client, scope, target);
      const replay = await client.query<RecordRow>(
        `SELECT ${fields} FROM youtube_unban_requests WHERE requested_by_account_id=$1 AND request_id=$2`,
        [scope.accountId, input.request_id],
      );
      if (replay.rows[0]) {
        const row = replay.rows[0];
        if (
          row.execution_id !== scope.executionId ||
          row.channel_id !== scope.channelId ||
          row.session_id !== scope.sessionId ||
          row.method !== input.method
        )
          throw failure(
            409,
            'REQUEST_ID_REUSED',
            'This request ID belongs to a different removal request.',
          );
        return { row, target, reused: true };
      }
      const previous = await client.query<{ status: string }>(
        `SELECT status FROM youtube_unban_requests WHERE ban_attempt_id=$1 ORDER BY requested_at DESC,id DESC`,
        [target.attempt_id],
      );
      if (
        previous.rows.some((row) =>
          ['DISPATCHED', 'SUCCEEDED', 'USER_CONFIRMED'].includes(row.status),
        )
      )
        throw failure(
          409,
          'REMOVAL_ALREADY_RECORDED',
          'A removal is already in progress or has been confirmed.',
        );
      if (input.method === 'YOUTUBE' && previous.rows.some((row) => row.status === 'UNKNOWN'))
        throw failure(
          409,
          'REMOVAL_OUTCOME_UNKNOWN',
          'The earlier removal has an uncertain outcome. Check YouTube Studio and confirm removal there.',
        );
      if (
        input.method === 'YOUTUBE' &&
        (!this.config.GOOGLE_AUTH_ENABLED || target.credential_account_id !== scope.accountId)
      )
        throw failure(
          409,
          'RECONNECT_REQUIRED',
          'The original channel owner must reconnect Google before requesting removal.',
        );
      const row = await this.insert(client, scope, target, input);
      await this.publish(client, scope, target);
      return { row, target, reused: false };
    });
    if (prepared.reused || input.method === 'STUDIO_CONFIRMATION')
      return unbanResponse.parse({ removal: summary(prepared.row), reused: prepared.reused });

    let token: string;
    try {
      token = await this.provider.accessToken(prepared.target.credential_account_id);
    } catch {
      return this.complete(scope, prepared.target, prepared.row.id, {
        status: 'NOT_SENT',
        code: 'REQUEST_CANCELLED',
      });
    }

    // Recheck access after any token refresh and before the irreversible request.
    let ready: boolean;
    try {
      ready = await transaction(this.database.pool, async (client) => {
        await this.authorize(client, scope);
        const current = await client.query(
          `SELECT id FROM youtube_unban_requests WHERE id=$1 AND status='DISPATCHED' AND deadline_at>clock_timestamp()`,
          [prepared.row.id],
        );
        return current.rows.length === 1;
      });
    } catch {
      return this.complete(scope, prepared.target, prepared.row.id, {
        status: 'NOT_SENT',
        code: 'REQUEST_CANCELLED',
      });
    }
    if (!ready)
      return this.complete(scope, prepared.target, prepared.row.id, {
        status: 'NOT_SENT',
        code: 'REQUEST_CANCELLED',
      });
    let result: YoutubeUnbanResult;
    try {
      result = await this.provider.removeBan({ accessToken: token, banId: prepared.target.ban_id });
    } catch {
      result = { status: 'UNKNOWN', http_status: null, code: 'TRANSPORT_ERROR' };
    }
    return this.complete(scope, prepared.target, prepared.row.id, result);
  }

  private async insert(client: PoolClient, scope: Scope, target: Target, input: UnbanRequest) {
    const rows = await client.query<RecordRow>(
      `WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS at)
       INSERT INTO youtube_unban_requests(id,request_id,ban_attempt_id,execution_id,channel_id,session_id,requested_by_account_id,credential_account_id,method,status,requested_at,deadline_at,finished_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,at,CASE WHEN $9='YOUTUBE' THEN at+interval '30 seconds' ELSE NULL END,CASE WHEN $9='STUDIO_CONFIRMATION' THEN at ELSE NULL END FROM moment RETURNING ${fields}`,
      [
        randomUUID(),
        input.request_id,
        target.attempt_id,
        scope.executionId,
        scope.channelId,
        scope.sessionId,
        scope.accountId,
        input.method === 'YOUTUBE' ? target.credential_account_id : null,
        input.method,
        input.method === 'YOUTUBE' ? 'DISPATCHED' : 'USER_CONFIRMED',
      ],
    );
    return rows.rows[0]!;
  }

  private async complete(scope: Scope, target: Target, id: string, result: YoutubeUnbanResult) {
    return transaction(this.database.pool, async (client) => {
      const updated = await client.query<RecordRow>(
        `UPDATE youtube_unban_requests SET status=$2,http_status=$3,error_code=$4,finished_at=GREATEST(clock_timestamp(),requested_at)
         WHERE id=$1 AND status='DISPATCHED' AND deadline_at>clock_timestamp() RETURNING ${fields}`,
        [
          id,
          result.status,
          result.status === 'NOT_SENT' ? null : result.http_status,
          result.status === 'SUCCEEDED' ? null : result.code,
        ],
      );
      if (updated.rows[0]) {
        await this.publish(client, scope, target);
        return unbanResponse.parse({ removal: summary(updated.rows[0]), reused: false });
      }
      await this.recover(client, scope, target);
      const current = await client.query<RecordRow>(
        `SELECT ${fields} FROM youtube_unban_requests WHERE id=$1`,
        [id],
      );
      return unbanResponse.parse({ removal: summary(current.rows[0]!), reused: false });
    });
  }
}

@Controller('v1/channels/:channel_id/sessions/:session_id/ban-executions/:execution_id/unban')
class UnbanController {
  constructor(private readonly service: UnbanService) {}
  private scope(
    request: ApiRequest,
    channelId: string,
    sessionId: string,
    executionId: string,
  ): Scope {
    return {
      accountId: request.account!.id,
      sessionHash: request.sessionHash!,
      channelId,
      sessionId,
      executionId,
    };
  }
  @Get()
  history(
    @Param('channel_id') channelId: string,
    @Param('session_id') sessionId: string,
    @Param('execution_id') executionId: string,
    @Req() request: ApiRequest,
  ) {
    return this.service.history(this.scope(request, channelId, sessionId, executionId));
  }
  @Post()
  @HttpCode(200)
  remove(
    @Param('channel_id') channelId: string,
    @Param('session_id') sessionId: string,
    @Param('execution_id') executionId: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return this.service.request(this.scope(request, channelId, sessionId, executionId), body);
  }
}

@Module({
  controllers: [UnbanController],
  providers: [
    UnbanService,
    {
      provide: UNBAN_PROVIDER,
      inject: [DatabaseService, APP_CONFIG],
      useFactory: (database: DatabaseService, config: AppConfig): UnbanProvider => {
        const tokens = new GoogleTokenStore(database.pool, config, new GoogleProvider());
        const adapter = new YoutubeUnbanAdapter();
        return {
          accessToken: (account) => tokens.accessToken(account),
          removeBan: (input) => adapter.removeBan(input),
        };
      },
    },
  ],
})
export class UnbanModule {}
