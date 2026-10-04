import { aiShadowResult, type AiShadowIdentity } from '@moderator/contracts';

// Queue age starts at local persistence, independent of the provider's timestamp.
export const AI_MAX_QUEUE_AGE_MS = 120_000;

export function expiredAiInput(identity: AiShadowIdentity) {
  return aiShadowResult.parse({
    ...identity,
    status: 'ERROR',
    rating: null,
    severity_score: null,
    truncated: null,
    inference_ms: null,
    error_code: 'INPUT_EXPIRED',
  });
}
