import { z } from 'zod';

export const youtubeBroadcastId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const monitoringRequestKey = z.uuid();

export const monitoringStatus = z.enum(['STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED']);

export const startMonitoringInput = z.strictObject({
  youtube_broadcast_id: youtubeBroadcastId,
});

export const stopMonitoringInput = z.strictObject({});

export const monitoringRun = z
  .strictObject({
    id: z.uuid(),
    channel_id: z.uuid(),
    session_id: z.uuid(),
    youtube_broadcast_id: youtubeBroadcastId,
    status: monitoringStatus,
    requested_at: z.iso.datetime(),
    started_at: z.iso.datetime().nullable(),
    stop_requested_at: z.iso.datetime().nullable(),
    finished_at: z.iso.datetime().nullable(),
    last_error_code: z.string().min(1).max(128).nullable(),
  })
  .superRefine((run, context) => {
    const terminal = run.status === 'STOPPED' || run.status === 'FAILED';

    if (terminal !== (run.finished_at !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['finished_at'],
        message: 'Only terminal runs must have a completion timestamp.',
      });
    }

    if (run.status === 'RUNNING' && run.started_at === null) {
      context.addIssue({
        code: 'custom',
        path: ['started_at'],
        message: 'Running monitoring requires a start timestamp.',
      });
    }

    if (run.status === 'STOPPING' && run.stop_requested_at === null) {
      context.addIssue({
        code: 'custom',
        path: ['stop_requested_at'],
        message: 'Stopping monitoring requires a stop request timestamp.',
      });
    }

    const requested = Date.parse(run.requested_at);

    for (const field of ['started_at', 'stop_requested_at', 'finished_at'] as const) {
      const value = run[field];

      if (value !== null && Date.parse(value) < requested) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'The timestamp cannot precede the monitoring request.',
        });
      }
    }

    if (run.finished_at !== null) {
      for (const field of ['started_at', 'stop_requested_at'] as const) {
        const value = run[field];

        if (value !== null && Date.parse(run.finished_at) < Date.parse(value)) {
          context.addIssue({
            code: 'custom',
            path: ['finished_at'],
            message: 'Completion cannot precede the start or stop request.',
          });
        }
      }
    }
  });

export const startMonitoringResponse = z.strictObject({
  run: monitoringRun,
  reused: z.boolean(),
});

export const stopMonitoringResponse = z.strictObject({
  run: monitoringRun,
});

export const monitoringStatusResponse = z.strictObject({
  run: monitoringRun.nullable(),
});

export type MonitoringRun = z.infer<typeof monitoringRun>;
export type MonitoringStatus = z.infer<typeof monitoringStatus>;
export type StartMonitoringInput = z.infer<typeof startMonitoringInput>;
