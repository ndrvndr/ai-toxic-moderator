import { z } from 'zod';
import { moderationActionPlan } from './moderation-action';
import { moderationTimeoutDuration } from './moderation-settings';

const id = z.uuid().transform((value) => value.toLowerCase());
const scope = { run_id: id, channel_id: id, session_id: id, classification_id: id };

export const blacklistActionPlanInput = z.strictObject({
  ...scope,
  external_message_id: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value.trim().length > 0, 'A message target is required.'),
  author_channel_id: z.string().max(1024).nullable(),
});

/** A decision groups independent message and author plans, not execution outcomes. */
export const blacklistActionBundle = z
  .strictObject({
    schema_version: z.literal(1),
    ...scope,
    policy_version: z.string().min(1).max(110),
    matcher_version: z.string().min(1).max(64),
    blacklist_id: id.nullable(),
    blacklist_revision: z.number().int().positive().safe().nullable(),
    source: z.enum(['SAVED', 'DEFAULT', 'LEGACY']),
    matched_rule_ids: z.array(id).max(100),
    selected_rule_id: id.nullable(),
    selected_action: z.enum(['DELETE', 'DELETE_TIMEOUT', 'DELETE_BAN']).nullable(),
    duration_seconds: moderationTimeoutDuration.nullable(),
    author_action_status: z.enum(['NOT_SELECTED', 'PLANNED', 'TARGET_UNAVAILABLE']),
    plans: z.array(moderationActionPlan).max(2),
  })
  .superRefine((bundle, context) => {
    const invalid = (message: string) => context.addIssue({ code: 'custom', message });
    if (bundle.source === 'SAVED') {
      if (!bundle.blacklist_id || bundle.blacklist_revision === null)
        invalid('Saved decisions require blacklist revision metadata.');
    } else if (
      bundle.blacklist_id !== null ||
      bundle.blacklist_revision !== null ||
      bundle.matched_rule_ids.length > 0
    ) {
      invalid('Default and legacy decisions cannot reference a saved blacklist or select actions.');
    }
    const ids = bundle.matched_rule_ids;
    if (
      new Set(ids).size !== ids.length ||
      ids.some((value, index) => index > 0 && value < ids[index - 1]!)
    ) {
      invalid('Matched entry IDs must be unique and sorted.');
    }
    if (ids.length === 0) {
      if (
        bundle.selected_rule_id !== null ||
        bundle.selected_action !== null ||
        bundle.duration_seconds !== null ||
        bundle.plans.length !== 0 ||
        bundle.author_action_status !== 'NOT_SELECTED'
      )
        invalid('Unmatched decisions cannot contain action plans.');
      return;
    }
    if (
      !bundle.selected_rule_id ||
      !ids.includes(bundle.selected_rule_id) ||
      !bundle.selected_action
    ) {
      invalid('A matched decision must select a matching entry and action.');
    }
    const authorRequested =
      bundle.selected_action === 'DELETE_TIMEOUT' || bundle.selected_action === 'DELETE_BAN';
    if ((bundle.selected_action === 'DELETE_TIMEOUT') !== (bundle.duration_seconds !== null))
      invalid('Only timeout decisions require a duration.');
    if (
      (!authorRequested && bundle.author_action_status !== 'NOT_SELECTED') ||
      (authorRequested && bundle.author_action_status === 'NOT_SELECTED')
    )
      invalid('Author planning status must match the selected action.');
    const expectedCount = bundle.author_action_status === 'PLANNED' ? 2 : 1;
    if (bundle.plans.length !== expectedCount)
      invalid('The decision must contain exactly one message plan and at most one author plan.');
    const deletion = bundle.plans[0];
    if (
      deletion?.action !== 'DELETE' ||
      deletion.policy_version !== `${bundle.policy_version}:message`
    )
      invalid('Matched decisions require an independent deletion plan.');
    const author = bundle.plans[1];
    if (author) {
      const expectedAction = bundle.selected_action === 'DELETE_TIMEOUT' ? 'TIMEOUT' : 'BAN';
      if (
        author.action !== expectedAction ||
        author.policy_version !== `${bundle.policy_version}:author`
      )
        invalid('Author plan must match the selected action and policy slot.');
      if (
        (author.action === 'TIMEOUT' || author.action === 'BAN') &&
        !/^UC[A-Za-z0-9_-]{22}$/.test(author.author_channel_id)
      )
        invalid('Author plans require a valid YouTube channel target.');
      if (author.action === 'TIMEOUT' && author.duration_seconds !== bundle.duration_seconds)
        invalid('Author timeout must use the selected duration.');
    }
    for (const plan of bundle.plans) {
      if (
        plan.classification_id.toLowerCase() !== bundle.classification_id ||
        plan.channel_id.toLowerCase() !== bundle.channel_id ||
        plan.session_id.toLowerCase() !== bundle.session_id
      )
        invalid('All plans must belong to the decision scope.');
    }
  });

export type BlacklistActionBundle = z.infer<typeof blacklistActionBundle>;
