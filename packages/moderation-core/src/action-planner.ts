import {
  moderationActionPlan,
  signal,
  type ModerationActionPlan,
  type Signal,
} from '@moderator/contracts';
import { z } from 'zod';

const automaticDeleteRule = z.strictObject({
  rule_id: z.string().min(1).max(128),
  rule_version: z.string().min(1).max(128),
  minimum_severity: z.number().int().min(1).max(4),
});

const actionPolicy = z.strictObject({
  version: z.string().min(1).max(128),
  delete_rules: z.array(automaticDeleteRule),
});

export type ActionPolicy = z.infer<typeof actionPolicy>;

export type ActionPlannerInput = {
  classification_id: string;
  channel_id: string;
  session_id: string;
  external_message_id: string;
  signals: readonly Signal[];
};

export class ActionPlanner {
  private readonly policy: ActionPolicy;

  constructor(policy: ActionPolicy) {
    this.policy = actionPolicy.parse(policy);
  }

  plan(input: ActionPlannerInput): ModerationActionPlan {
    const signals = signal.array().parse(input.signals);

    const candidates = signals
      .filter(
        (entry) =>
          entry.strength === 'STRONG' &&
          this.policy.delete_rules.some(
            (rule) =>
              rule.rule_id === entry.rule_id &&
              rule.rule_version === entry.rule_version &&
              entry.severity >= rule.minimum_severity,
          ),
      )
      .sort(
        (left, right) =>
          right.severity - left.severity ||
          left.rule_id.localeCompare(right.rule_id) ||
          left.rule_version.localeCompare(right.rule_version),
      );

    const selected = candidates[0];

    const context = {
      classification_id: input.classification_id,
      channel_id: input.channel_id,
      session_id: input.session_id,
      policy_version: this.policy.version,
    };

    if (!selected) {
      return moderationActionPlan.parse({
        ...context,
        action: 'NONE',
        reason: 'No signal met the configured automatic deletion policy.',
      });
    }

    return moderationActionPlan.parse({
      ...context,
      action: 'DELETE',
      external_message_id: input.external_message_id,
      reason:
        `Rule ${selected.rule_id} version ${selected.rule_version} ` +
        'met the configured automatic deletion policy.',
    });
  }
}
