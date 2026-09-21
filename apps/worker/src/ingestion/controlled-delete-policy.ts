import { ActionPlanner, RuleDetectionEngine } from '@moderator/moderation-core';
import { createHash } from 'node:crypto';
import { DEFAULT_RULES } from './default-rules';

export type ControlledDeleteScope = { sessionId: string; authorChannelId: string };
export const CONTROLLED_DELETE_MESSAGE = 'ATM_DELETE_TEST_V1';

export function controlledDeleteVersion(scope: ControlledDeleteScope): string {
  return (
    'delete-test-' +
    createHash('sha256')
      .update(JSON.stringify([scope.sessionId, scope.authorChannelId]))
      .digest('hex')
  );
}

export function controlledDeletePolicy(scope: ControlledDeleteScope) {
  const version = controlledDeleteVersion(scope);
  const normal = new RuleDetectionEngine(DEFAULT_RULES);
  const test = new RuleDetectionEngine([
    {
      id: 'development.controlled-delete',
      version: '1',
      category: 'SPAM',
      severity: 1,
      strength: 'STRONG',
      intent: 'CONTROLLED_DELETE_TEST',
      // Unlike $, the negative lookahead rejects a trailing newline as well.
      pattern: /^ATM_DELETE_TEST_V1(?![\s\S])/u,
    },
  ]);
  const planner = new ActionPlanner({
    version,
    delete_rules: [
      {
        rule_id: 'development.controlled-delete',
        rule_version: '1',
        minimum_severity: 1,
      },
    ],
  });
  return {
    version,
    engine: {
      async detect(input: Parameters<RuleDetectionEngine['detect']>[0]) {
        const signals = await normal.detect(input);
        return input.author_external_id === scope.authorChannelId
          ? [...signals, ...(await test.detect(input))]
          : signals;
      },
    },
    planner: {
      plan(input: Parameters<ActionPlanner['plan']>[0]) {
        return planner.plan({
          ...input,
          signals: input.session_id === scope.sessionId ? input.signals : [],
        });
      },
    },
  };
}
