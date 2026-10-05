import { ActionPlanner, ModerationPolicy, RuleDetectionEngine } from '@moderator/moderation-core';

import { ActionPlanStore } from './action-plan-store';
import { BlacklistActionStore } from './blacklist-action-store';
import { ClassificationStore } from './classification-store';
import { controlledBanPolicy, type ControlledBanScope } from './controlled-ban-policy';
import { controlledDeletePolicy, type ControlledDeleteScope } from './controlled-delete-policy';
import { RunBlacklistMatcher } from './run-blacklist-matcher';

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

  return new ClassificationStore(
    // Ordinary messages have no developer-maintained detection rules. AI runs separately.
    controlled?.engine ?? new RuleDetectionEngine([]),
    new ModerationPolicy(),
    controlled?.version ?? 'blacklist-only-1',
    'policy-1',
    {
      planner:
        controlled?.planner ?? new ActionPlanner({ version: 'blacklist-only-1', delete_rules: [] }),
      store: actionPlans,
    },
    controlled ? undefined : { resolver: new RunBlacklistMatcher(), store: blacklistDecisions },
  );
}
