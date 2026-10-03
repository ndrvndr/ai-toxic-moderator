import {
  customBlacklistRecord,
  customBlacklistUpdate,
  uuid,
  type CustomBlacklistRecord,
  type CustomBlacklistUpdate,
} from '@moderator/contracts';
import { transaction, type PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

type BlacklistRow = Omit<CustomBlacklistRecord, 'created_at'> & { created_at: Date };

export class CustomBlacklistConflict extends Error {
  constructor(readonly currentRevision: number) {
    super('Blacklist changed. Reload before saving.');
    this.name = 'CustomBlacklistConflict';
  }
}

export class CustomBlacklistStore {
  constructor(private readonly pool: Pool) {}

  // The caller must authorize reads. Writes always recheck access in the transaction.
  async getLatest(channelId: string): Promise<CustomBlacklistRecord | null> {
    return this.readLatest(this.pool, uuid.parse(channelId).toLowerCase());
  }

  async save(
    channelId: string,
    accountId: string,
    input: CustomBlacklistUpdate,
    authorize: (client: PoolClient) => Promise<void>,
  ): Promise<CustomBlacklistRecord> {
    const channel = uuid.parse(channelId).toLowerCase();
    const actor = uuid.parse(accountId).toLowerCase();
    const update = customBlacklistUpdate.parse(input);
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `custom-blacklist:${channel}`,
      ]);
      await authorize(client);
      const current = await this.readLatest(client, channel);
      const revision = current?.revision ?? 0;
      if (revision !== update.expected_revision) throw new CustomBlacklistConflict(revision);

      const result = await client.query<BlacklistRow>(
        `INSERT INTO channel_custom_blacklists(id, channel_id, revision, configuration, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, channel_id, revision, configuration, created_by, created_at`,
        [randomUUID(), channel, revision + 1, JSON.stringify(update.configuration), actor],
      );
      return this.record(result.rows[0]!);
    });
  }

  private async readLatest(client: Pool | PoolClient, channelId: string) {
    const result = await client.query<BlacklistRow>(
      `SELECT id, channel_id, revision, configuration, created_by, created_at
       FROM channel_custom_blacklists WHERE channel_id = $1 ORDER BY revision DESC LIMIT 1`,
      [channelId],
    );
    return result.rows[0] ? this.record(result.rows[0]) : null;
  }

  private record(row: BlacklistRow): CustomBlacklistRecord {
    return customBlacklistRecord.parse({ ...row, created_at: row.created_at.toISOString() });
  }
}
