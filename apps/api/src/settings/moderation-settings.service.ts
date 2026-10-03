import {
  BUILTIN_MODERATION_RULE_CATALOG,
  moderationRuleCatalogResponse,
  moderationSettingsResponse,
  moderationSettingsUpdate,
  uuid,
} from '@moderator/contracts';
import type { PoolClient } from '@moderator/persistence';
import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database.module';
import { failure } from '../http';
import { ModerationSettingsConflict, ModerationSettingsStore } from './moderation-settings-store';

@Injectable()
export class ModerationSettingsService {
  private readonly store: ModerationSettingsStore;

  constructor(private readonly database: DatabaseService) {
    this.store = new ModerationSettingsStore(database.pool);
  }

  async read(accountId: string, channelId: string) {
    const channel = this.channel(channelId);
    await this.requireAccess(accountId, channel, false);
    return moderationSettingsResponse.parse({ settings: await this.store.getLatest(channel) });
  }

  async rules(accountId: string, channelId: string) {
    await this.requireAccess(accountId, this.channel(channelId), false);
    return moderationRuleCatalogResponse.parse({ items: BUILTIN_MODERATION_RULE_CATALOG });
  }

  async save(accountId: string, channelId: string, body: unknown) {
    const channel = this.channel(channelId);
    await this.requireAccess(accountId, channel, true);
    const parsed = moderationSettingsUpdate.safeParse(body);
    if (!parsed.success) {
      throw failure(
        422,
        'VALIDATION_ERROR',
        'Provide valid moderation settings.',
        parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), code: issue.code })),
      );
    }

    parsed.data.configuration.rules.forEach((rule, index) => {
      const supported = BUILTIN_MODERATION_RULE_CATALOG.find(
        (entry) => entry.rule_id === rule.rule_id && entry.rule_version === rule.rule_version,
      );
      if (!supported) {
        throw failure(422, 'UNSUPPORTED_RULE', 'Select a supported rule and its current version.', [
          { field: `configuration.rules.${index}.rule_id`, code: 'unsupported_rule' },
        ]);
      }
      if (supported.strength !== 'STRONG' || !supported.supported_actions.includes(rule.action)) {
        throw failure(
          422,
          'UNSUPPORTED_RULE_ACTION',
          'This rule does not support automatic actions.',
          [{ field: `configuration.rules.${index}.action`, code: 'unsupported_action' }],
        );
      }
    });

    try {
      const settings = await this.store.save(channel, accountId, parsed.data, (client) =>
        this.requireAccess(accountId, channel, true, client),
      );
      return moderationSettingsResponse.parse({ settings });
    } catch (error) {
      if (error instanceof ModerationSettingsConflict) {
        throw failure(409, 'SETTINGS_REVISION_CONFLICT', 'Settings changed. Reload before saving.');
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
        'SETTINGS_WRITE_FORBIDDEN',
        'Only the channel owner can change moderation settings.',
      );
    }
  }
}
