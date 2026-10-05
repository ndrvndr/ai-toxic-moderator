import { z } from 'zod';

import { aiShadowSummary } from './ai-shadow';
import { chatAiDecision } from './chat-ai-decision';
import { customBlacklistRule } from './custom-blacklist';
import { category, outcome } from './moderation-enums';

export const chatOutcomeFilter = z.enum([...outcome.options, 'NOT_EVALUATED']);

export const chatQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  outcome: chatOutcomeFilter.optional(),
  category: category.optional(),
});

export const chatCursor = z.strictObject({
  version: z.literal(1),
  channel_id: z.uuid(),
  session_id: z.uuid(),
  received_at: z.iso.datetime({ precision: 6 }),
  id: z.uuid(),
  outcome: chatOutcomeFilter.optional(),
  category: category.optional(),
});

export const classificationReasonCode = z.enum([
  'NO_RULE_MATCH',
  'CONTEXT_REQUIRED',
  'GAMBLING_PROMOTION',
  'DIRECT_INSULT',
  'PROCESSING_FAILED',
  'BLACKLIST_MATCH',
]);

export const chatEvaluation = z.strictObject({
  outcome,
  primary_category: category.nullable(),
  severity: z.number().int().min(0).max(4).nullable(),
  reason_code: classificationReasonCode,
  reason: z.string().min(1).max(2000),
  classifier_version: z.string().min(1).max(128),
  policy_version: z.string().min(1).max(128),
});

export const chatDeletion = z.strictObject({
  action: z.literal('DELETE'),
  status: z.enum(['PENDING', 'DISPATCHED', 'SUCCEEDED', 'REJECTED', 'NOT_SENT', 'UNKNOWN']),
});

export const authorActionBlockReason = z.enum([
  'PREVIOUS_OUTCOME_UNKNOWN',
  'AUTHOR_ALREADY_BANNED',
  'MESSAGE_BEFORE_TIMEOUT_END',
  'MESSAGE_BEFORE_UNBAN',
  'AUTHOR_ACTION_IN_PROGRESS',
  'TIMEOUT_WINDOW_ACTIVE',
]);

export const authorActionEvidence = z.strictObject({
  matching_event_observed: z.boolean(),
  attribution: z.literal('UNPROVEN'),
});

const authorActionFields = {
  status: z.enum([...chatDeletion.shape.status.options, 'BLOCKED', 'SUPPRESSED']),
  block_reason: authorActionBlockReason.optional(),
  evidence: authorActionEvidence.optional(),
};

export const chatAuthorAction = z
  .discriminatedUnion('action', [
    z.strictObject({
      ...authorActionFields,
      action: z.literal('TIMEOUT'),
      duration_seconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
    z.strictObject({
      ...authorActionFields,
      action: z.literal('BAN'),
      duration_seconds: z.null(),
    }),
  ])
  .superRefine((value, context) => {
    const valid =
      value.status === 'SUPPRESSED'
        ? value.block_reason === 'MESSAGE_BEFORE_TIMEOUT_END' ||
          value.block_reason === 'MESSAGE_BEFORE_UNBAN'
        : value.status === 'BLOCKED'
          ? value.block_reason !== undefined &&
            !['MESSAGE_BEFORE_TIMEOUT_END', 'MESSAGE_BEFORE_UNBAN'].includes(value.block_reason)
          : value.block_reason === undefined;

    if (!valid) {
      context.addIssue({
        code: 'custom',
        path: ['block_reason'],
        message: 'The blocking reason must match the action status.',
      });
    }

    if (value.evidence !== undefined && value.status !== 'UNKNOWN') {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Candidate evidence is only supported for unknown request outcomes.',
      });
    }
  });

/** Captured streamer policy, separate from provider execution outcomes. */
export const chatBlacklistDecision = z
  .strictObject({
    run_id: z.uuid(),
    blacklist_id: z.uuid(),
    blacklist_revision: z.number().int().positive().safe(),
    source: z.literal('SAVED'),
    matcher_version: z.string().min(1).max(64),
    matched_rule_ids: z.array(z.uuid()).min(1).max(100),
    selected_entry: customBlacklistRule,
    author_action_status: z.enum(['NOT_SELECTED', 'PLANNED', 'TARGET_UNAVAILABLE']),
  })
  .superRefine((value, context) => {
    const ids = value.matched_rule_ids;
    if (
      !value.selected_entry.enabled ||
      !ids.includes(value.selected_entry.id) ||
      new Set(ids).size !== ids.length ||
      ids.some((id, index) => index > 0 && id < ids[index - 1]!)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The selected entry must belong to unique sorted matches.',
      });
    }
    if (
      (value.selected_entry.action === 'DELETE') !==
      (value.author_action_status === 'NOT_SELECTED')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Author planning must match the selected policy.',
      });
    }
  });

export const chatObservation = z
  .strictObject({
    id: z.uuid(),
    external_message_id: z.string().min(1).max(1024),
    event_type: z.string().min(1).max(128),
    published_at: z.iso.datetime(),
    received_at: z.iso.datetime(),
    display_text: z.string().nullable(),
    author_channel_id: z.string().nullable(),
    author_display_name: z.string().nullable(),
    evaluation_status: z.enum(['NOT_EVALUATED', 'ALLOW', 'REVIEW', 'ACTION_REQUIRED', 'ERROR']),
    evaluation: chatEvaluation.nullable(),
    deletion: chatDeletion.nullable().optional(),
    author_action: chatAuthorAction.nullable().optional(),
    ai_shadow: aiShadowSummary.nullable().optional(),
    ai_decision: chatAiDecision.nullable().optional(),
    blacklist: chatBlacklistDecision.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.ai_decision && value.event_type !== 'textMessageEvent') {
      context.addIssue({
        code: 'custom',
        path: ['ai_decision'],
        message: 'AI policy evidence belongs to an observed text message.',
      });
    }
    if (
      value.blacklist &&
      (value.evaluation_status !== 'ACTION_REQUIRED' ||
        value.evaluation?.outcome !== 'ACTION_REQUIRED' ||
        value.evaluation.reason_code !== 'BLACKLIST_MATCH' ||
        value.evaluation.primary_category !== null ||
        value.evaluation.severity !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['blacklist'],
        message: 'Blacklist provenance requires the displayed streamer policy evaluation.',
      });
    }
  });

export const chatPage = z.strictObject({
  items: z.array(chatObservation),
  next_cursor: z.string().nullable(),
});

export type ChatObservation = z.infer<typeof chatObservation>;
export type ChatPage = z.infer<typeof chatPage>;
export type ChatEvaluation = z.infer<typeof chatEvaluation>;
export type ChatDeletion = z.infer<typeof chatDeletion>;
export type ChatAuthorAction = z.infer<typeof chatAuthorAction>;
export type ChatBlacklistDecision = z.infer<typeof chatBlacklistDecision>;
