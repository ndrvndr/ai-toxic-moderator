import { ActionPlanner, ModerationPolicy, RuleDetectionEngine } from '@moderator/moderation-core';

import { ActionPlanStore } from './action-plan-store';
import { BlacklistActionStore } from './blacklist-action-store';
import { ClassificationStore } from './classification-store';
import { controlledBanPolicy, type ControlledBanScope } from './controlled-ban-policy';
import { controlledDeletePolicy, type ControlledDeleteScope } from './controlled-delete-policy';
import { DEFAULT_RULES } from './default-rules';
import { RunBlacklistMatcher } from './run-blacklist-matcher';
import { RunSettingsPlanner } from './run-settings-planner';

export function createClassificationStore(
  actionPlans: Pick<ActionPlanStore, 'save'> = new ActionPlanStore(),
  testScope?: ControlledDeleteScope,
  banTestScope?: ControlledBanScope,
  blacklistDecisions: Pick<BlacklistActionStore, 'save'> = new BlacklistActionStore(actionPlans),
) {
  if (testScope && banTestScope) {
    throw new Error('Only one controlled action policy can be active.');
  }

  const controlled = banTestScope
    ? controlledBanPolicy(banTestScope)
    : testScope
      ? controlledDeletePolicy(testScope)
      : undefined;

  const snapshots = new RunSettingsPlanner();

  return new ClassificationStore(
    controlled?.engine ?? new RuleDetectionEngine(DEFAULT_RULES),
    new ModerationPolicy(),
    controlled?.version ?? 'rules-blacklist-1',
    'policy-1',
    {
      planner: controlled?.planner ?? new ActionPlanner({ version: 'actions-1', delete_rules: [] }),
      store: actionPlans,
      ...(!controlled
        ? {
            resolvePlanner: snapshots.resolve.bind(snapshots),
          }
        : {}),
    },
    controlled ? undefined : { resolver: new RunBlacklistMatcher(), store: blacklistDecisions },
  );
}
