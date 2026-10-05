import { z } from 'zod';

/** The server resolves the provider ban ID from the scoped execution record. */
export const unbanRequest = z.discriminatedUnion('method', [
  z.strictObject({ request_id: z.uuid(), method: z.literal('YOUTUBE') }),
  z.strictObject({
    request_id: z.uuid(),
    method: z.literal('STUDIO_CONFIRMATION'),
    confirmed: z.literal(true),
  }),
]);

const identity = {
  id: z.uuid(),
  execution_id: z.uuid(),
  requested_at: z.iso.datetime(),
};

/** Removal evidence is separate from the original ban execution outcome. */
export const unbanSummary = z.discriminatedUnion('method', [
  z
    .strictObject({
      ...identity,
      method: z.literal('YOUTUBE'),
      status: z.enum(['DISPATCHED', 'SUCCEEDED', 'REJECTED', 'NOT_SENT', 'UNKNOWN']),
      finished_at: z.iso.datetime().nullable(),
    })
    .superRefine((value, context) => {
      if ((value.status === 'DISPATCHED') !== (value.finished_at === null)) {
        context.addIssue({
          code: 'custom',
          path: ['finished_at'],
          message: 'Only an in-progress request may have no completion time.',
        });
      }
      if (value.finished_at && Date.parse(value.finished_at) < Date.parse(value.requested_at)) {
        context.addIssue({
          code: 'custom',
          path: ['finished_at'],
          message: 'Completion cannot precede the request.',
        });
      }
    }),
  z
    .strictObject({
      ...identity,
      method: z.literal('STUDIO_CONFIRMATION'),
      status: z.literal('USER_CONFIRMED'),
      finished_at: z.iso.datetime(),
    })
    .superRefine((value, context) => {
      if (Date.parse(value.finished_at) < Date.parse(value.requested_at)) {
        context.addIssue({
          code: 'custom',
          path: ['finished_at'],
          message: 'Confirmation cannot precede the request.',
        });
      }
    }),
]);

export type UnbanRequest = z.infer<typeof unbanRequest>;
export type UnbanSummary = z.infer<typeof unbanSummary>;
export const unbanResponse = z.strictObject({ removal: unbanSummary, reused: z.boolean() });
export const unbanHistory = z.strictObject({ items: z.array(unbanSummary).max(50) });
