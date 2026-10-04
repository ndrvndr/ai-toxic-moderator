import {
  aiModerationSettingsRecord,
  aiModerationSettingsUpdate,
  uuid,
  type AiModerationSettingsRecord,
  type AiModerationSettingsUpdate,
} from '@moderator/contracts';
import { transaction, type PoolClient } from '@moderator/persistence';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

type SettingsRow = Omit<AiModerationSettingsRecord, 'created_at'> & { created_at: Date };

export class AiModerationSettingsConflict extends Error {
  constructor(readonly currentRevision: number) {
    super('AI moderation settings changed. Reload before saving.');
    this.name = 'AiModerationSettingsConflict';
  }
}

export class AiModerationSettingsStore {
  constructor(private readonly pool: Pool) {}

  // The caller must authorize reads. Writes recheck access after acquiring the revision lock.
  async getLatest(channelId: string): Promise<AiModerationSettingsRecord | null> {
    return this.readLatest(this.pool, uuid.parse(channelId).toLowerCase());
  }

  async save(
    channelId: string,
    accountId: string,
    input: AiModerationSettingsUpdate,
    authorize: (client: PoolClient) => Promise<void>,
  ): Promise<AiModerationSettingsRecord> {
    const channel = uuid.parse(channelId).toLowerCase();
    const actor = uuid.parse(accountId).toLowerCase();
    const update = aiModerationSettingsUpdate.parse(input);
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `ai-moderation-settings:${channel}`,
      ]);
      await authorize(client);
      const current = await this.readLatest(client, channel);
      const revision = current?.revision ?? 0;
      if (revision !== update.expected_revision) throw new AiModerationSettingsConflict(revision);

      const result = await client.query<SettingsRow>(
        `INSERT INTO channel_ai_moderation_settings(id, channel_id, revision, configuration, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, channel_id, revision, configuration, created_by, created_at`,
        [randomUUID(), channel, revision + 1, JSON.stringify(update.configuration), actor],
      );
      return this.record(result.rows[0]!);
    });
  }

  private async readLatest(client: Pool | PoolClient, channelId: string) {
    const result = await client.query<SettingsRow>(
      `SELECT id, channel_id, revision, configuration, created_by, created_at
       FROM channel_ai_moderation_settings WHERE channel_id = $1 ORDER BY revision DESC LIMIT 1`,
      [channelId],
    );
    return result.rows[0] ? this.record(result.rows[0]) : null;
  }

  private record(row: SettingsRow): AiModerationSettingsRecord {
    return aiModerationSettingsRecord.parse({ ...row, created_at: row.created_at.toISOString() });
  }
}
