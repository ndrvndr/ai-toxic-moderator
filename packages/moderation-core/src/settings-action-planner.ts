import {
  BUILTIN_MODERATION_RULE_CATALOG,
  moderationActionPlan,
  moderationSettingsConfiguration,
  signal,
  type ModerationActionPlan,
  type ModerationSettingsConfiguration,
} from '@moderator/contracts';

import { z } from 'zod';
import type { ActionPlannerInput } from './action-planner';

/** Select one action from a validated, immutable run configuration. */
export class SettingsActionPlanner {
  private readonly configuration: ModerationSettingsConfiguration;

  constructor(
    configuration: unknown,
    private readonly version: string,
  ) {
    this.configuration = moderationSettingsConfiguration.parse(configuration);
    z.string().min(1).max(128).parse(version);
  }

  plan(input: ActionPlannerInput): ModerationActionPlan {
    const signals = signal.array().parse(input.signals);
    const context = {
      classification_id: input.classification_id,
      channel_id: input.channel_id,
      session_id: input.session_id,
      policy_version: this.version,
    };
    const none = (reason: string) =>
      moderationActionPlan.parse({ ...context, action: 'NONE', reason });

    if (!this.configuration.automatic_actions_enabled) {
      return none('Automatic actions are disabled in this run configuration.');
    }

    const candidates = signals
      .flatMap((entry) => {
        const rule = this.configuration.rules.find(
          (configured) =>
            configured.rule_id === entry.rule_id && configured.rule_version === entry.rule_version,
        );
        const catalog = BUILTIN_MODERATION_RULE_CATALOG.find(
          (supported) =>
            supported.rule_id === entry.rule_id && supported.rule_version === entry.rule_version,
        );
        if (
          !rule ||
          !catalog ||
          entry.strength !== 'STRONG' ||
          catalog.strength !== 'STRONG' ||
          entry.category !== catalog.category ||
          !catalog.supported_actions.includes(rule.action) ||
          entry.severity < rule.minimum_severity
        )
          return [];
        return [{ entry, rule }];
      })
      .sort(
        (left, right) =>
          right.entry.severity - left.entry.severity ||
          left.entry.rule_id.localeCompare(right.entry.rule_id) ||
          left.entry.rule_version.localeCompare(right.entry.rule_version),
      );

    const selected = candidates[0];
    if (!selected)
      return none('No signal met the supported automatic action configuration for this run.');
    const { rule } = selected;
    const reason = `Rule ${rule.rule_id} version ${rule.rule_version} met this run's automatic ${rule.action.toLowerCase()} configuration.`;
    if (rule.action === 'DELETE') {
      return moderationActionPlan.parse({
        ...context,
        action: 'DELETE',
        external_message_id: input.external_message_id,
        reason,
      });
    }
    // Missing/fallback author identities must never become author action targets.
    if (!input.author_channel_id || !/^UC[A-Za-z0-9_-]{22}$/.test(input.author_channel_id)) {
      return none('The classified message has no valid YouTube author channel target.');
    }
    return moderationActionPlan.parse({
      ...context,
      action: rule.action,
      author_channel_id: input.author_channel_id,
      ...(rule.action === 'TIMEOUT' ? { duration_seconds: rule.duration_seconds } : {}),
      reason,
    });
  }
}
