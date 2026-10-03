import { z } from 'zod';

export const aiShadowRating = z.union([z.literal(0), z.literal(2), z.literal(3), z.literal(4)]);
export const aiShadowErrorCode = z.enum([
  'MODEL_UNAVAILABLE',
  'INFERENCE_FAILED',
  'INFERENCE_TIMEOUT',
  'INVALID_OUTPUT',
  'INPUT_TOO_LONG',
]);

const identity = {
  channel_id: z.uuid(),
  session_id: z.uuid(),
  observation_id: z.uuid(),
  run_id: z.uuid(),
  model_id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  model_revision: z.string().regex(/^[a-f0-9]{40}$/),
  model_variant: z.literal('INT8'),
  adapter_version: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.-]+$/),
};

export const aiShadowIdentity = z.strictObject(identity);
export type AiShadowIdentity = z.infer<typeof aiShadowIdentity>;

// This result carries model output only, never an application category or action decision.
export const aiShadowResult = z.discriminatedUnion('status', [
  z.strictObject({
    ...identity,
    status: z.literal('SUCCEEDED'),
    rating: aiShadowRating,
    severity_score: z.number().min(0).max(1),
    truncated: z.boolean(),
    inference_ms: z.number().min(0).max(3_600_000),
    error_code: z.null(),
  }),
  z.strictObject({
    ...identity,
    status: z.literal('ERROR'),
    rating: z.null(),
    severity_score: z.null(),
    truncated: z.null(),
    inference_ms: z.null(),
    error_code: aiShadowErrorCode,
  }),
]);

export type AiShadowResult = z.infer<typeof aiShadowResult>;
// Public chat projection excludes internal provenance IDs and carries no action decision.
const privateIdentity = {
  channel_id: true,
  session_id: true,
  observation_id: true,
  run_id: true,
} as const;
export const aiShadowSummary = z.discriminatedUnion('status', [
  aiShadowResult.options[0].omit(privateIdentity),
  aiShadowResult.options[1].omit(privateIdentity),
]);
export type AiShadowSummary = z.infer<typeof aiShadowSummary>;
export type AiShadowErrorCode = z.infer<typeof aiShadowErrorCode>;
