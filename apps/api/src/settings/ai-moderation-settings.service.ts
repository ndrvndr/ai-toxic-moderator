import {
  aiModerationSettingsResponse,
  aiModerationSettingsUpdate,
  uuid,
} from '@moderator/contracts';
import type { PoolClient } from '@moderator/persistence';
import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database.module';
import { failure } from '../http';
import {
  AiModerationSettingsConflict,
  AiModerationSettingsStore,
} from './ai-moderation-settings-store';

@Injectable()
export class AiModerationSettingsService {
  private readonly store: AiModerationSettingsStore;

  constructor(private readonly database: DatabaseService) {
    this.store = new AiModerationSettingsStore(database.pool);
  }

  async read(accountId: string, channelId: string) {
    const channel = this.channel(channelId);
    await this.requireAccess(accountId, channel, false);
    return aiModerationSettingsResponse.parse({ settings: await this.store.getLatest(channel) });
  }

  async save(accountId: string, channelId: string, body: unknown) {
    const channel = this.channel(channelId);
    await this.requireAccess(accountId, channel, true);
    const parsed = aiModerationSettingsUpdate.safeParse(body);
    if (!parsed.success) {
      throw failure(
        422,
        'VALIDATION_ERROR',
        'Provide valid AI moderation settings.',
        parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), code: issue.code })),
      );
    }
    try {
      const settings = await this.store.save(channel, accountId, parsed.data, (client) =>
        this.requireAccess(accountId, channel, true, client),
      );
      return aiModerationSettingsResponse.parse({ settings });
    } catch (error) {
      if (error instanceof AiModerationSettingsConflict) {
        throw failure(
          409,
          'AI_SETTINGS_REVISION_CONFLICT',
          'AI moderation settings changed. Reload before saving.',
        );
      }
      throw error;
    }
  }

  private channel(channelId: string) {
    const parsed = uuid.safeParse(channelId);
    if (!parsed.success) throw failure(422, 'VALIDATION_ERROR', 'Provide a valid channel ID.');
    return parsed.data.toLowerCase();
  }

  private async requireAccess(
    accountId: string,
    channelId: string,
    write: boolean,
    client?: PoolClient,
  ) {
    const result = await (client ?? this.database.pool).query<{ role: string }>(
      `SELECT role FROM channel_memberships WHERE channel_id = $1 AND account_id = $2${client ? ' FOR SHARE' : ''}`,
      [channelId, accountId],
    );
    const role = result.rows[0]?.role;
    if (!role || !['OWNER', 'MODERATOR'].includes(role)) {
      throw failure(403, 'CHANNEL_FORBIDDEN', 'You do not have access to this channel.');
    }
    if (write && role !== 'OWNER') {
      throw failure(
        403,
        'AI_SETTINGS_WRITE_FORBIDDEN',
        'Only the channel owner can change AI moderation settings.',
      );
    }
  }
}
