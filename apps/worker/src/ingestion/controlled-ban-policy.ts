import { moderationActionPlan } from '@moderator/contracts';
import { ActionPlanner, RuleDetectionEngine } from '@moderator/moderation-core';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const scopeSchema = z.strictObject({
  sessionId: z.uuid(),
  authorChannelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
  action: z.enum(['TIMEOUT', 'BAN']),
});

export type ControlledBanScope = z.infer<typeof scopeSchema>;

export const CONTROLLED_TIMEOUT_MESSAGE = 'ATM_TIMEOUT_TEST_V1';
export const CONTROLLED_BAN_MESSAGE = 'ATM_BAN_TEST_V1';
export const CONTROLLED_TIMEOUT_SECONDS = 30;

export function controlledBanVersion(input: ControlledBanScope): string {
  const scope = scopeSchema.parse(input);

  return (
    'ban-test-' +
    createHash('sha256')
      .update(
        JSON.stringify([
          '1',
          scope.sessionId,
          scope.authorChannelId,
          scope.action,
          scope.action === 'TIMEOUT' ? CONTROLLED_TIMEOUT_SECONDS : null,
        ]),
      )
      .digest('hex')
  );
}

export function controlledBanPolicy(input: ControlledBanScope) {
  const scope = scopeSchema.parse(input);
  const version = controlledBanVersion(scope);

  // Bind the signal to this exact scope and action.
  const ruleId = `development.${version}`;
  const intent = 'CONTROLLED_AUTHOR_ACTION_TEST';

  const test = new RuleDetectionEngine([
    {
      id: ruleId,
      version: '1',
      category: 'SPAM',
      severity: 1,
      strength: 'STRONG',
      intent,
      pattern:
        scope.action === 'TIMEOUT'
          ? /^ATM_TIMEOUT_TEST_V1(?![\s\S])/u
          : /^ATM_BAN_TEST_V1(?![\s\S])/u,
    },
  ]);

  return {
    version,
    engine: {
      async detect(message: Parameters<RuleDetectionEngine['detect']>[0]) {
        return message.author_external_id === scope.authorChannelId
          ? await test.detect(message)
          : [];
      },
    },
    planner: {
      plan(input: Parameters<ActionPlanner['plan']>[0]) {
        const context = {
          classification_id: input.classification_id,
          channel_id: input.channel_id,
          session_id: input.session_id,
          policy_version: version,
        };

        const matched =
          input.session_id === scope.sessionId &&
          input.signals.some(
            (entry) =>
              entry.rule_id === ruleId &&
              entry.rule_version === '1' &&
              entry.strength === 'STRONG' &&
              entry.intent === intent,
          );

        if (!matched) {
          return moderationActionPlan.parse({
            ...context,
            action: 'NONE',
            reason: 'The controlled author action conditions were not met.',
          });
        }

        if (scope.action === 'TIMEOUT') {
          return moderationActionPlan.parse({
            ...context,
            action: 'TIMEOUT',
            author_channel_id: scope.authorChannelId,
            duration_seconds: CONTROLLED_TIMEOUT_SECONDS,
            reason: 'The scoped controlled timeout marker matched.',
          });
        }

        return moderationActionPlan.parse({
          ...context,
          action: 'BAN',
          author_channel_id: scope.authorChannelId,
          reason: 'The scoped controlled ban marker matched.',
        });
      },
    },
  };
}
