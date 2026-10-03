import { z } from 'zod';

import { classificationReasonCode } from './chat';
import { category } from './moderation-enums';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const flaggedReasonSummary = z.strictObject({
  category: category.nullable(),
  reason_code: classificationReasonCode,
  message_count: count.min(1),
});

export const historyStatistics = z
  .strictObject({
    session_id: z.uuid(),
    total_messages: count,
    allowed_messages: count,
    flagged_messages: count,
    error_messages: count,
    unevaluated_messages: count,
    flagged_reasons: z.array(flaggedReasonSummary),
  })
  .refine(
    (value) =>
      value.total_messages ===
      value.allowed_messages +
        value.flagged_messages +
        value.error_messages +
        value.unevaluated_messages,
    {
      message: 'Message counts must add up to the total.',
    },
  )
  .refine(
    (value) =>
      value.flagged_reasons.reduce((total, reason) => total + reason.message_count, 0) ===
      value.flagged_messages,
    {
      path: ['flagged_reasons'],
      message: 'Reason counts must add up to the flagged total.',
    },
  )
  .refine(
    (value) =>
      new Set(value.flagged_reasons.map((reason) => `${reason.category}:${reason.reason_code}`))
        .size === value.flagged_reasons.length,
    {
      path: ['flagged_reasons'],
      message: 'Category and reason pairs must be unique.',
    },
  );

export type HistoryStatistics = z.infer<typeof historyStatistics>;
