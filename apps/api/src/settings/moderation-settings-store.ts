import {
  moderationSettingsRecord,
  moderationSettingsUpdate,
  uuid,
  type ModerationSettingsRecord,
  type ModerationSettingsUpdate,
} from '@moderator/contracts';
import { transaction, type PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

type SettingsRow = Omit<ModerationSettingsRecord, 'created_at'> & { created_at: Date };

export class ModerationSettingsConflict extends Error {
  constructor(readonly currentRevision: number) {
    super('Moderation settings changed. Reload before saving.');
    this.name = 'ModerationSettingsConflict';
  }
}

export class ModerationSettingsStore {
  constructor(private readonly pool: Pool) {}

  // The calling service must authorize channel access before reading or writing.
  async getLatest(channelId: string): Promise<ModerationSettingsRecord | null> {
    return this.readLatest(this.pool, uuid.parse(channelId).toLowerCase());
  }

  async save(
    channelId: string,
    accountId: string,
    input: ModerationSettingsUpdate,
    authorize?: (client: PoolClient) => Promise<void>,
  ): Promise<ModerationSettingsRecord> {
    const channel = uuid.parse(channelId).toLowerCase();
    const actor = uuid.parse(accountId).toLowerCase();
    const update = moderationSettingsUpdate.parse(input);

    return transaction(this.pool, async (client) => {
      // Match the migration's channel lock, including canonical UUID casing.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `moderation-settings:${channel}`,
      ]);

      // The service can lock and recheck membership within the same transaction.
      if (authorize) await authorize(client);

      const current = await this.readLatest(client, channel);
      const revision = current?.revision ?? 0;
      if (revision !== update.expected_revision) {
        throw new ModerationSettingsConflict(revision);
      }

      const result = await client.query<SettingsRow>(
        `INSERT INTO channel_moderation_settings(
           id, channel_id, revision, configuration, created_by
         ) VALUES($1, $2, $3, $4::jsonb, $5)
         RETURNING id, channel_id, revision, configuration, created_by, created_at`,
        [randomUUID(), channel, revision + 1, JSON.stringify(update.configuration), actor],
      );

      return this.record(result.rows[0]!);
    });
  }

  private async readLatest(
    client: Pool | PoolClient,
    channelId: string,
  ): Promise<ModerationSettingsRecord | null> {
    const result = await client.query<SettingsRow>(
      `SELECT id, channel_id, revision, configuration, created_by, created_at
       FROM channel_moderation_settings
       WHERE channel_id = $1
       ORDER BY revision DESC
       LIMIT 1`,
      [channelId],
    );
    return result.rows[0] ? this.record(result.rows[0]) : null;
  }

  private record(row: SettingsRow): ModerationSettingsRecord {
    return moderationSettingsRecord.parse({ ...row, created_at: row.created_at.toISOString() });
  }
}
