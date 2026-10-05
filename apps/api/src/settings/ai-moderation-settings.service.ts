import {
  LASKAR_ADAPTER_VERSION,
  LASKAR_MODEL_ID,
  LASKAR_MODEL_VARIANT,
  type AppConfig,
} from '@moderator/config';
import {
  aiModerationModelIdentity,
  aiModerationPreferencesUpdate,
  aiModerationSettingsResponse,
  uuid,
} from '@moderator/contracts';
import type { PoolClient } from '@moderator/persistence';
import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, DatabaseService } from '../database.module';
import { failure } from '../http';
import {
  AiModerationSettingsConflict,
  AiModerationSettingsStore,
} from './ai-moderation-settings-store';

@Injectable()
export class AiModerationSettingsService {
  private readonly store: AiModerationSettingsStore;

  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
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
    const parsed = aiModerationPreferencesUpdate.safeParse(body);
    if (!parsed.success) {
      throw failure(
        422,
        'VALIDATION_ERROR',
        'Provide valid AI moderation settings.',
        parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), code: issue.code })),
      );
    }
    const model = aiModerationModelIdentity.safeParse({
      model_id: LASKAR_MODEL_ID,
      model_revision: this.config.AI_SHADOW_MODEL_REVISION,
      model_variant: LASKAR_MODEL_VARIANT,
      adapter_version: LASKAR_ADAPTER_VERSION,
    });
    if (!model.success)
      throw failure(
        503,
        'AI_MODEL_NOT_CONFIGURED',
        'The application AI model has not been configured.',
      );
    try {
      const settings = await this.store.save(
        channel,
        accountId,
        {
          ...parsed.data,
          configuration: { ...parsed.data.configuration, model: model.data },
        },
        (client) => this.requireAccess(accountId, channel, true, client),
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
