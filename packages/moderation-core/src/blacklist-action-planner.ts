import {
  blacklistActionBundle,
  blacklistActionPlanInput,
  customBlacklistSnapshot,
  type BlacklistActionBundle,
  type CustomBlacklistSnapshot,
  type ModerationActionPlan,
} from '@moderator/contracts';
import {
  CUSTOM_BLACKLIST_MATCHER_VERSION,
  CustomBlacklistMatcher,
} from './custom-blacklist-matcher';

/** Build independent executor-compatible plans from a captured run configuration. */
export class BlacklistActionPlanner {
  private readonly snapshot: CustomBlacklistSnapshot;
  private readonly matcher: CustomBlacklistMatcher;

  constructor(snapshot: unknown) {
    this.snapshot = customBlacklistSnapshot.parse(snapshot);
    this.matcher = new CustomBlacklistMatcher(this.snapshot.configuration);
  }

  plan(input: unknown, rawText: string): BlacklistActionBundle {
    const context = blacklistActionPlanInput.parse(input);
    if (
      context.run_id !== this.snapshot.run_id.toLowerCase() ||
      context.channel_id !== this.snapshot.channel_id.toLowerCase()
    ) {
      throw new Error('The blacklist planner snapshot does not belong to this run and channel.');
    }
    const decision = this.matcher.match(rawText);
    const version = `blacklist-${CUSTOM_BLACKLIST_MATCHER_VERSION}-${context.run_id}`;
    const plans: ModerationActionPlan[] = [];
    let status: BlacklistActionBundle['author_action_status'] = 'NOT_SELECTED';
    const selected = this.snapshot.configuration.rules.find(
      (rule) => rule.id === decision.selected_rule_id,
    );
    const planScope = {
      classification_id: context.classification_id,
      channel_id: context.channel_id,
      session_id: context.session_id,
    };
    if (selected) {
      plans.push({
        ...planScope,
        policy_version: `${version}:message`,
        action: 'DELETE',
        external_message_id: context.external_message_id,
        reason: `Blacklist entry ${selected.id} selected deletion for this message.`,
      });
      if (decision.author_action) {
        if (context.author_channel_id && /^UC[A-Za-z0-9_-]{22}$/.test(context.author_channel_id)) {
          status = 'PLANNED';
          plans.push({
            ...planScope,
            policy_version: `${version}:author`,
            author_channel_id: context.author_channel_id,
            reason: `Blacklist entry ${selected.id} selected an author ${decision.author_action.action.toLowerCase()} request.`,
            ...decision.author_action,
          });
        } else status = 'TARGET_UNAVAILABLE';
      }
    }
    return blacklistActionBundle.parse({
      schema_version: 1,
      ...planScope,
      run_id: context.run_id,
      policy_version: version,
      matcher_version: CUSTOM_BLACKLIST_MATCHER_VERSION,
      blacklist_id: this.snapshot.blacklist_id,
      blacklist_revision: this.snapshot.blacklist_revision,
      source: this.snapshot.source,
      matched_rule_ids: decision.matched_rule_ids,
      selected_rule_id: decision.selected_rule_id,
      selected_action: selected?.action ?? null,
      duration_seconds: selected?.action === 'DELETE_TIMEOUT' ? selected.duration_seconds : null,
      author_action_status: status,
      plans,
    });
  }
}
