import {
  monitoringRequestKey,
  monitoringRun,
  monitoringStatusResponse,
  startMonitoringInput,
  startMonitoringResponse,
  stopMonitoringInput,
  stopMonitoringResponse,
  uuid,
} from '@moderator/contracts';
import { transaction, type PoolClient } from '@moderator/persistence';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { GoogleService } from '../auth/google.service';
import { DatabaseService } from '../database.module';
import { failure } from '../http';
import { resolveYoutubeSession } from './youtube-session';

@Injectable()
export class MonitoringService {
  constructor(
    private readonly database: DatabaseService,
    private readonly google: GoogleService,
  ) {}

  async start(accountId: string, requestKey: string, body: unknown) {
    const input = startMonitoringInput.safeParse(body);
    const key = monitoringRequestKey.safeParse(requestKey);

    if (!input.success || !key.success) {
      throw failure(
        422,
        'VALIDATION_ERROR',
        'Provide a valid broadcast ID and a UUID idempotency key.',
      );
    }

    const broadcastId = input.data.youtube_broadcast_id;

    // Replays do not require another Google request, even after the stream ends.
    const replay = await transaction(this.database.pool, async (client) => {
      await this.lockRequest(client, accountId, key.data);

      return this.findReplay(client, accountId, key.data, broadcastId);
    });

    if (replay) return replay;

    // External requests run outside the database transaction.
    const broadcast = await this.google.verifyBroadcast(accountId, broadcastId);

    return transaction(this.database.pool, async (client) => {
      await this.lockRequest(client, accountId, key.data);

      // Another request may have completed while Google verification was running.
      const concurrentReplay = await this.findReplay(client, accountId, key.data, broadcastId);

      if (concurrentReplay) return concurrentReplay;

      const session = await resolveYoutubeSession(client, accountId, broadcast);

      const active = await client.query<{ id: string }>(
        `
          SELECT id
          FROM monitoring_runs
          WHERE session_id = $1
            AND status IN ('STARTING', 'RUNNING', 'STOPPING')
          FOR UPDATE
        `,
        [session.session_id],
      );

      let runId = active.rows[0]?.id;
      const reused = runId !== undefined;

      if (!runId) {
        runId = randomUUID();

        await client.query(
          `
            INSERT INTO monitoring_runs(
              id,
              channel_id,
              session_id,
              requested_by_account_id,
              credential_account_id,
              status
            )
            VALUES($1, $2, $3, $4, $4, 'STARTING')
          `,
          [runId, session.channel_id, session.session_id, accountId],
        );
      }

      await client.query(
        `
          INSERT INTO monitoring_start_requests(
            account_id,
            request_key,
            monitoring_run_id
          )
          VALUES($1, $2, $3)
        `,
        [accountId, key.data, runId],
      );

      return startMonitoringResponse.parse({
        run: await this.readRun(client, runId),
        reused,
      });
    });
  }

  async status(accountId: string, channelId: string, runId: string) {
    this.validateIds(channelId, runId);

    return transaction(this.database.pool, async (client) => {
      await this.requireAccess(client, accountId, channelId);

      const run = await this.readRun(client, runId);

      if (run.channel_id !== channelId) {
        throw failure(404, 'MONITORING_RUN_NOT_FOUND', 'The monitoring run was not found.');
      }

      return monitoringStatusResponse.parse({ run });
    });
  }

  async stop(accountId: string, channelId: string, runId: string, body: unknown) {
    this.validateIds(channelId, runId);

    if (!stopMonitoringInput.safeParse(body).success) {
      throw failure(422, 'VALIDATION_ERROR', 'The stop request body must be an empty object.');
    }

    return transaction(this.database.pool, async (client) => {
      await this.requireAccess(client, accountId, channelId);

      const result = await client.query<{ status: string }>(
        `
          SELECT status
          FROM monitoring_runs
          WHERE id = $1 AND channel_id = $2
          FOR UPDATE
        `,
        [runId, channelId],
      );

      const row = result.rows[0];

      if (!row) {
        throw failure(404, 'MONITORING_RUN_NOT_FOUND', 'The monitoring run was not found.');
      }

      if (row.status === 'STARTING' || row.status === 'RUNNING') {
        await client.query(
          `
            WITH moment AS MATERIALIZED (
              SELECT
                GREATEST(
                  clock_timestamp(),
                  requested_at,
                  started_at
                ) AS at
              FROM monitoring_runs
              WHERE id = $1
            )
            UPDATE monitoring_runs
            SET
              status = CASE
                WHEN status = 'STARTING' THEN 'STOPPED'
                ELSE 'STOPPING'
              END,
              stop_requested_at = moment.at,
              stopped_by_account_id = $2,
              finished_at = CASE
                WHEN status = 'STARTING' THEN moment.at
                ELSE NULL
              END
            FROM moment
            WHERE id = $1
          `,
          [runId, accountId],
        );
      }

      return stopMonitoringResponse.parse({
        run: await this.readRun(client, runId),
      });
    });
  }

  private validateIds(channelId: string, runId: string) {
    if (!uuid.safeParse(channelId).success || !uuid.safeParse(runId).success) {
      throw failure(422, 'VALIDATION_ERROR', 'Provide valid channel and monitoring run IDs.');
    }
  }

  private async requireAccess(client: PoolClient, accountId: string, channelId: string) {
    const result = await client.query<{ role: string }>(
      `
        SELECT role
        FROM channel_memberships
        WHERE channel_id = $1 AND account_id = $2
        FOR SHARE
      `,
      [channelId, accountId],
    );

    if (!['OWNER', 'MODERATOR'].includes(result.rows[0]?.role ?? '')) {
      throw failure(403, 'CHANNEL_FORBIDDEN', 'You do not have access to this channel.');
    }
  }

  private async lockRequest(client: PoolClient, accountId: string, requestKey: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `monitoring-start:${accountId}:${requestKey}`,
    ]);
  }

  private async findReplay(
    client: PoolClient,
    accountId: string,
    requestKey: string,
    broadcastId: string,
  ) {
    const result = await client.query<{
      monitoring_run_id: string;
      youtube_broadcast_id: string;
      role: string | null;
    }>(
      `
        SELECT
          request.monitoring_run_id,
          broadcast.youtube_broadcast_id,
          membership.role
        FROM monitoring_start_requests request
        JOIN monitoring_runs run
          ON run.id = request.monitoring_run_id
        JOIN youtube_broadcasts broadcast
          ON broadcast.session_id = run.session_id
          AND broadcast.channel_id = run.channel_id
        LEFT JOIN channel_memberships membership
          ON membership.channel_id = run.channel_id
          AND membership.account_id = request.account_id
        WHERE request.account_id = $1 AND request.request_key = $2
      `,
      [accountId, requestKey],
    );

    const existing = result.rows[0];

    if (!existing) return null;

    if (existing.youtube_broadcast_id !== broadcastId) {
      throw failure(
        409,
        'IDEMPOTENCY_KEY_CONFLICT',
        'This idempotency key was already used for another broadcast.',
      );
    }

    if (!['OWNER', 'MODERATOR'].includes(existing.role ?? '')) {
      throw failure(403, 'CHANNEL_FORBIDDEN', 'You no longer have access to this channel.');
    }

    return startMonitoringResponse.parse({
      run: await this.readRun(client, existing.monitoring_run_id),
      reused: true,
    });
  }

  private async readRun(client: PoolClient, runId: string) {
    const result = await client.query<{
      id: string;
      channel_id: string;
      session_id: string;
      youtube_broadcast_id: string;
      status: string;
      requested_at: Date;
      started_at: Date | null;
      stop_requested_at: Date | null;
      finished_at: Date | null;
      last_error_code: string | null;
    }>(
      `
        SELECT
          run.id,
          run.channel_id,
          run.session_id,
          broadcast.youtube_broadcast_id,
          run.status,
          run.requested_at,
          run.started_at,
          run.stop_requested_at,
          run.finished_at,
          run.last_error_code
        FROM monitoring_runs run
        JOIN youtube_broadcasts broadcast
          ON broadcast.session_id = run.session_id
          AND broadcast.channel_id = run.channel_id
        WHERE run.id = $1
      `,
      [runId],
    );

    const row = result.rows[0];

    if (!row) {
      throw failure(404, 'MONITORING_RUN_NOT_FOUND', 'The monitoring run was not found.');
    }

    return monitoringRun.parse({
      ...row,
      requested_at: row.requested_at.toISOString(),
      started_at: row.started_at?.toISOString() ?? null,
      stop_requested_at: row.stop_requested_at?.toISOString() ?? null,
      finished_at: row.finished_at?.toISOString() ?? null,
    });
  }
}
