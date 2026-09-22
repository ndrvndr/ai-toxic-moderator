import { ActionPlanner, ModerationPolicy, RuleDetectionEngine } from '@moderator/moderation-core';

import { ActionPlanStore } from './action-plan-store';
import { ClassificationStore } from './classification-store';
import { controlledBanPolicy, type ControlledBanScope } from './controlled-ban-policy';
import { controlledDeletePolicy, type ControlledDeleteScope } from './controlled-delete-policy';
import { DEFAULT_RULES } from './default-rules';

export function createClassificationStore(
  actionPlans: Pick<ActionPlanStore, 'save'> = new ActionPlanStore(),
  testScope?: ControlledDeleteScope,
  banTestScope?: ControlledBanScope,
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
    controlled?.engine ?? new RuleDetectionEngine(DEFAULT_RULES),
    new ModerationPolicy(),
    controlled?.version ?? 'rules-1',
    'policy-1',
    {
      planner: controlled?.planner ?? new ActionPlanner({ version: 'actions-1', delete_rules: [] }),
      store: actionPlans,
    },
  );
}
