import { z } from 'zod';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const actionExecutionCounts = z
  .strictObject({
    total: count,
    dispatched: count,
    succeeded: count,
    rejected: count,
    not_sent: count,
    unknown: count,
  })
  .refine(
    (value) =>
      value.total ===
      value.dispatched + value.succeeded + value.rejected + value.not_sent + value.unknown,
    {
      message: 'Execution outcome counts must add up to the total.',
    },
  );

export const historyActionStatistics = z.strictObject({
  session_id: z.uuid(),
  delete: actionExecutionCounts,
  timeout: actionExecutionCounts,
  ban: actionExecutionCounts,
});

export type ActionExecutionCounts = z.infer<typeof actionExecutionCounts>;
export type HistoryActionStatistics = z.infer<typeof historyActionStatistics>;
