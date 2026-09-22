import {
  appendLiveEvent,
  transaction,
  type createPool,
  type PoolClient,
} from '@moderator/persistence';

type DatabasePool = ReturnType<typeof createPool>;

export type WorkerLease = Readonly<{
  run_id: string;
  owner_id: string;
  generation: string;
}>;

export class LeaseLostError extends Error {
  constructor() {
    super('The worker no longer owns an active lease.');
    this.name = 'LeaseLostError';
  }
}

export class LeaseStore {
  constructor(
    private readonly pool: DatabasePool,
    private readonly ttlSeconds = 30,
  ) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 300) {
      throw new Error('Lease duration must be between 5 and 300 seconds.');
    }
  }

  async claim(runId: string, ownerId: string): Promise<WorkerLease | null> {
    return transaction(this.pool, async (client) => {
      const run = await client.query<{ status: string }>(
        'SELECT status FROM monitoring_runs WHERE id = $1 FOR UPDATE',
        [runId],
      );

      if (!['STARTING', 'RUNNING', 'STOPPING'].includes(run.rows[0]?.status ?? '')) {
        return null;
      }

      await client.query(
        `
          INSERT INTO monitoring_worker_leases(run_id)
          VALUES($1)
          ON CONFLICT(run_id) DO NOTHING
        `,
        [runId],
      );

      const result = await client.query<{ generation: string }>(
        `
          WITH moment AS MATERIALIZED (
            SELECT clock_timestamp() AS at
          )
          UPDATE monitoring_worker_leases
          SET
            generation = generation + 1,
            owner_id = $2,
            acquired_at = moment.at,
            heartbeat_at = moment.at,
            expires_at = moment.at + $3 * interval '1 second'
          FROM moment
          WHERE run_id = $1
            AND (owner_id IS NULL OR expires_at <= moment.at)
          RETURNING generation::text
        `,
        [runId, ownerId, this.ttlSeconds],
      );

      const row = result.rows[0];

      if (!row) return null;

      return Object.freeze({
        run_id: runId,
        owner_id: ownerId,
        generation: row.generation,
      });
    });
  }

  async heartbeat(lease: WorkerLease): Promise<void> {
    await this.withLease(lease, async (client) => {
      const result = await client.query(
        `
          WITH moment AS MATERIALIZED (
            SELECT clock_timestamp() AS at
          )
          UPDATE monitoring_worker_leases
          SET
            heartbeat_at = GREATEST(heartbeat_at, moment.at),
            expires_at =
              GREATEST(heartbeat_at, moment.at) + $4 * interval '1 second'
          FROM moment
          WHERE run_id = $1
            AND owner_id = $2
            AND generation = $3::bigint
            AND expires_at > moment.at
        `,
        [lease.run_id, lease.owner_id, lease.generation, this.ttlSeconds],
      );

      if (result.rowCount !== 1) throw new LeaseLostError();
    });
  }

  async release(lease: WorkerLease): Promise<void> {
    await transaction(this.pool, async (client) => {
      await this.assertOwned(client, lease);

      const result = await client.query(
        `
          UPDATE monitoring_worker_leases
          SET
            owner_id = NULL,
            acquired_at = NULL,
            heartbeat_at = NULL,
            expires_at = NULL
          WHERE run_id = $1
            AND owner_id = $2
            AND generation = $3::bigint
            AND expires_at > clock_timestamp()
        `,
        [lease.run_id, lease.owner_id, lease.generation],
      );

      if (result.rowCount !== 1) throw new LeaseLostError();
    });
  }

  async finish(
    lease: WorkerLease,
    status: 'STOPPED' | 'FAILED',
    errorCode: string | null = null,
  ): Promise<'STOPPED' | 'FAILED'> {
    if (
      (status === 'FAILED' && (errorCode === null || !/^[A-Z][A-Z0-9_]{0,127}$/.test(errorCode))) ||
      (status === 'STOPPED' && errorCode !== null)
    ) {
      throw new Error('Provide a safe error code only when marking a run failed.');
    }

    return transaction(this.pool, async (client) => {
      await this.assertOwned(client, lease);

      const result = await client.query<{
        status: 'STOPPED' | 'FAILED';
        channel_id: string;
        session_id: string;
      }>(
        `
          UPDATE monitoring_runs AS run
          SET
            status = CASE
              WHEN run.status = 'STOPPING' THEN 'STOPPED'
              ELSE $4
            END,
            finished_at = GREATEST(
              clock_timestamp(),
              run.requested_at,
              run.started_at,
              run.stop_requested_at
            ),
            last_error_code = CASE
              WHEN run.status = 'STOPPING' THEN NULL
              ELSE $5
            END
          FROM monitoring_worker_leases AS lease
          WHERE run.id = $1
            AND lease.run_id = run.id
            AND lease.owner_id = $2
            AND lease.generation = $3::bigint
            AND lease.expires_at > clock_timestamp()
            AND run.status IN ('STARTING', 'RUNNING', 'STOPPING')
          RETURNING run.status, run.channel_id, run.session_id
        `,
        [lease.run_id, lease.owner_id, lease.generation, status, errorCode],
      );

      const finished = result.rows[0];

      if (!finished) throw new LeaseLostError();

      await client.query(
        `
          UPDATE monitoring_worker_leases
          SET
            owner_id = NULL,
            acquired_at = NULL,
            heartbeat_at = NULL,
            expires_at = NULL
          WHERE run_id = $1
            AND owner_id = $2
            AND generation = $3::bigint
        `,
        [lease.run_id, lease.owner_id, lease.generation],
      );

      await appendLiveEvent(client, {
        channelId: finished.channel_id,
        sessionId: finished.session_id,
        runId: lease.run_id,
        type: 'monitoring.updated',
      });

      return finished.status;
    });
  }

  /**
   * Run short database-only work under the lease.
   * Fetch external data before calling this method.
   * All protected writes must use the supplied transaction client.
   */
  async withLease<T>(lease: WorkerLease, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return transaction(this.pool, async (client) => {
      await this.assertOwned(client, lease);

      const result = await work(client);

      // Roll back protected writes if the lease expired during the work.
      await this.assertOwned(client, lease);

      return result;
    });
  }

  private async assertOwned(client: PoolClient, lease: WorkerLease): Promise<void> {
    // Match the lifecycle service's lock order: run first, then lease.
    const run = await client.query<{ status: string }>(
      'SELECT status FROM monitoring_runs WHERE id = $1 FOR UPDATE',
      [lease.run_id],
    );

    if (!['STARTING', 'RUNNING', 'STOPPING'].includes(run.rows[0]?.status ?? '')) {
      throw new LeaseLostError();
    }

    const result = await client.query(
      `
        SELECT run_id
        FROM monitoring_worker_leases
        WHERE run_id = $1
          AND owner_id = $2
          AND generation = $3::bigint
          AND expires_at > clock_timestamp()
        FOR UPDATE
      `,
      [lease.run_id, lease.owner_id, lease.generation],
    );

    if (result.rows.length !== 1) throw new LeaseLostError();
  }
}
