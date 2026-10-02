import { z } from 'zod';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const historyStatistics = z
  .strictObject({
    session_id: z.uuid(),
    total_messages: count,
    allowed_messages: count,
    flagged_messages: count,
    error_messages: count,
    unevaluated_messages: count,
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
  );

export type HistoryStatistics = z.infer<typeof historyStatistics>;
