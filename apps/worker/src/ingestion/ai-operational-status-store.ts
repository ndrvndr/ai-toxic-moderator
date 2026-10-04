import { randomUUID } from 'node:crypto';

import { aiOperationalStatus, uuid, type AiOperationalStatus } from '@moderator/contracts';
import type { createPool } from '@moderator/persistence';

type DatabasePool = Pick<ReturnType<typeof createPool>, 'query'>;
type WithoutTimestamps<T> = T extends unknown ? Omit<T, 'updated_at' | 'heartbeat_at'> : never;
export type AiOperationalStatusUpdate = WithoutTimestamps<AiOperationalStatus>;
export type AiOperationalStatusLease = Readonly<{
  channel_id: string;
  owner_id: string;
  generation: string;
}>;

type ReportRow = AiOperationalStatusUpdate & { updated_at: Date; heartbeat_at: Date };
const projection = `channel_id, session_id, run_id, status, reason, error_code,
  updated_at, heartbeat_at`;

export class AiOperationalStatusStore {
  private readonly ownerId: string;

  constructor(
    private readonly pool: DatabasePool,
    ownerId = randomUUID(),
  ) {
    this.ownerId = uuid.parse(ownerId);
  }

  // Claim initializes WAITING. Retain the returned token and publish at a bounded
  // cadence; a live owner cannot be displaced. Reclaim only after expiration.
  async claim(channelId: string): Promise<AiOperationalStatusLease | null> {
    const channel = uuid.parse(channelId);
    const result = await this.pool.query<{ generation: string }>(
      `INSERT INTO ai_operational_status
        (channel_id, session_id, run_id, status, reason, error_code, owner_id, generation)
       VALUES ($1,NULL,NULL,'WAITING','NO_ELIGIBLE_RUN',NULL,$2,1)
       ON CONFLICT (channel_id) DO UPDATE SET
         owner_id = EXCLUDED.owner_id, generation = ai_operational_status.generation + 1,
         session_id = NULL, run_id = NULL, status = 'WAITING',
         reason = 'NO_ELIGIBLE_RUN', error_code = NULL
       WHERE ai_operational_status.expires_at <= clock_timestamp()
       RETURNING generation::text`,
      [channel, this.ownerId],
    );
    const row = result.rows[0];
    return row
      ? Object.freeze({ channel_id: channel, owner_id: this.ownerId, generation: row.generation })
      : null;
  }

  async publish(
    lease: AiOperationalStatusLease,
    update: AiOperationalStatusUpdate,
  ): Promise<AiOperationalStatus | null> {
    const channel = uuid.parse(lease.channel_id);
    const owner = uuid.parse(lease.owner_id);
    if (owner !== this.ownerId || !/^[1-9][0-9]{0,18}$/.test(lease.generation)) {
      throw new Error('Invalid AI status lease.');
    }
    if (
      Object.keys(update).some(
        (key) =>
          !['channel_id', 'session_id', 'run_id', 'status', 'reason', 'error_code'].includes(key),
      )
    )
      throw new Error('Invalid AI status update fields.');
    // Reuse all public state/scope validation while leaving actual clocks to PostgreSQL.
    const report = aiOperationalStatus.parse({
      ...update,
      updated_at: '2000-01-01T00:00:00Z',
      heartbeat_at: '2000-01-01T00:00:00Z',
    });
    if (report.channel_id !== channel) throw new Error('AI status lease scope mismatch.');
    const result = await this.pool.query<ReportRow>(
      `UPDATE ai_operational_status SET
         session_id=$4, run_id=$5, status=$6, reason=$7, error_code=$8
       WHERE channel_id=$1 AND owner_id=$2 AND generation=$3::bigint
         AND expires_at > clock_timestamp()
       RETURNING ${projection}`,
      [
        channel,
        owner,
        lease.generation,
        report.session_id,
        report.run_id,
        report.status,
        report.reason,
        report.error_code,
      ],
    );
    const row = result.rows[0];
    return row
      ? aiOperationalStatus.parse({
          ...row,
          updated_at: row.updated_at.toISOString(),
          heartbeat_at: row.heartbeat_at.toISOString(),
        })
      : null;
  }
}
