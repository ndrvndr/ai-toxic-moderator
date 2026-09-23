import { z } from 'zod';

import { category, outcome } from './moderation-enums';

export const chatQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

export const chatCursor = z.strictObject({
  version: z.literal(1),
  channel_id: z.uuid(),
  session_id: z.uuid(),
  received_at: z.iso.datetime({ precision: 6 }),
  id: z.uuid(),
});

export const classificationReasonCode = z.enum([
  'NO_RULE_MATCH',
  'CONTEXT_REQUIRED',
  'GAMBLING_PROMOTION',
  'DIRECT_INSULT',
  'PROCESSING_FAILED',
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
        ? value.block_reason === 'MESSAGE_BEFORE_TIMEOUT_END'
        : value.status === 'BLOCKED'
          ? value.block_reason !== undefined && value.block_reason !== 'MESSAGE_BEFORE_TIMEOUT_END'
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

export const chatObservation = z.strictObject({
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
