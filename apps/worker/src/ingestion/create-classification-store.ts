import { ActionPlanner, ModerationPolicy, RuleDetectionEngine } from '@moderator/moderation-core';

import { ActionPlanStore } from './action-plan-store';
import { ClassificationStore } from './classification-store';
import { DEFAULT_RULES } from './default-rules';

export function createClassificationStore(
  actionPlans: Pick<ActionPlanStore, 'save'> = new ActionPlanStore(),
) {
  return new ClassificationStore(
    new RuleDetectionEngine(DEFAULT_RULES),
    new ModerationPolicy(),
    'rules-1',
    'policy-1',
    {
      planner: new ActionPlanner({ version: 'actions-1', delete_rules: [] }),
      store: actionPlans,
    },
  );
}
