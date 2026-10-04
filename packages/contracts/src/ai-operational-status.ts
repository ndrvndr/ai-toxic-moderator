import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });
const scope = {
  channel_id: z.uuid(),
  session_id: z.uuid().nullable(),
  run_id: z.uuid().nullable(),
  updated_at: timestamp,
  heartbeat_at: timestamp,
};

export const aiOperationalState = z.enum([
  'DISABLED',
  'WAITING',
  'ACTIVE',
  'MODEL_MISMATCH',
  'CAPACITY_EXCEEDED',
  'ERROR',
]);

// Only allowlisted codes cross the API boundary; never publish raw worker errors.
export const aiOperationalErrorCode = z.enum([
  'MODEL_UNAVAILABLE',
  'INFERENCE_FAILED',
  'INFERENCE_TIMEOUT',
  'INVALID_OUTPUT',
  'DATABASE_UNAVAILABLE',
  'PIPELINE_FAILED',
]);

export const aiOperationalStatus = z
  .discriminatedUnion('status', [
    z.strictObject({
      ...scope,
      status: z.literal('DISABLED'),
      reason: z.enum(['WORKER_AI_DISABLED', 'RUN_AI_DISABLED']),
      error_code: z.null(),
    }),
    z.strictObject({
      ...scope,
      session_id: z.null(),
      run_id: z.null(),
      status: z.literal('WAITING'),
      reason: z.literal('NO_ELIGIBLE_RUN'),
      error_code: z.null(),
    }),
    z.strictObject({
      ...scope,
      session_id: z.uuid(),
      run_id: z.uuid(),
      status: z.literal('ACTIVE'),
      reason: z.literal('RUN_SELECTED'),
      error_code: z.null(),
    }),
    z.strictObject({
      ...scope,
      session_id: z.uuid(),
      run_id: z.uuid(),
      status: z.literal('MODEL_MISMATCH'),
      reason: z.literal('CAPTURED_MODEL_MISMATCH'),
      error_code: z.null(),
    }),
    z.strictObject({
      ...scope,
      session_id: z.null(),
      run_id: z.null(),
      status: z.literal('CAPACITY_EXCEEDED'),
      reason: z.literal('MULTIPLE_ELIGIBLE_RUNS'),
      error_code: z.null(),
    }),
    z.strictObject({
      ...scope,
      status: z.literal('ERROR'),
      reason: z.literal('PROCESSING_FAILED'),
      error_code: aiOperationalErrorCode,
    }),
  ])
  .superRefine((value, context) => {
    if ((value.session_id === null) !== (value.run_id === null)) {
      context.addIssue({
        code: 'custom',
        path: ['run_id'],
        message: 'Run and session scope must be supplied together.',
      });
    }
    if (value.status === 'DISABLED') {
      const scoped = value.run_id !== null;
      if ((value.reason === 'RUN_AI_DISABLED') !== scoped) {
        context.addIssue({
          code: 'custom',
          path: ['reason'],
          message: 'Disabled reason must match its scope.',
        });
      }
    }
    if (Date.parse(value.updated_at) > Date.parse(value.heartbeat_at)) {
      context.addIssue({
        code: 'custom',
        path: ['heartbeat_at'],
        message: 'Heartbeat must not precede the last state change.',
      });
    }
  });

// Freshness is assessed by the API, not by the browser's clock. STALE preserves
// the last report for diagnosis but must never be presented as currently active.
export const aiOperationalStatusResponse = z
  .discriminatedUnion('availability', [
    z.strictObject({
      channel_id: z.uuid(),
      availability: z.literal('UNKNOWN'),
      checked_at: timestamp,
      stale_after_ms: z.number().int().min(1).max(300_000),
      report: z.null(),
    }),
    z.strictObject({
      channel_id: z.uuid(),
      availability: z.enum(['ONLINE', 'STALE']),
      checked_at: timestamp,
      stale_after_ms: z.number().int().min(1).max(300_000),
      report: aiOperationalStatus,
    }),
  ])
  .superRefine((value, context) => {
    if (value.report === null) return;
    if (value.channel_id !== value.report.channel_id) {
      context.addIssue({
        code: 'custom',
        path: ['report', 'channel_id'],
        message: 'Report must belong to the requested channel.',
      });
    }
    const age = Date.parse(value.checked_at) - Date.parse(value.report.heartbeat_at);
    if (age < 0) {
      context.addIssue({
        code: 'custom',
        path: ['checked_at'],
        message: 'Check must not precede the heartbeat.',
      });
    } else if ((value.availability === 'STALE') !== age >= value.stale_after_ms) {
      context.addIssue({
        code: 'custom',
        path: ['availability'],
        message: 'Availability must match heartbeat age.',
      });
    }
  });

export type AiOperationalState = z.infer<typeof aiOperationalState>;
export type AiOperationalErrorCode = z.infer<typeof aiOperationalErrorCode>;
export type AiOperationalStatus = z.infer<typeof aiOperationalStatus>;
export type AiOperationalStatusResponse = z.infer<typeof aiOperationalStatusResponse>;
