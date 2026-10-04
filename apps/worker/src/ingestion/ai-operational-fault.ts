import { aiOperationalErrorCode, type AiOperationalErrorCode } from '@moderator/contracts';

export type AiOperationalFault = Readonly<{
  run_id: string | null;
  error_code: AiOperationalErrorCode;
  source: 'PIPELINE' | 'INFERENCE';
}>;

export function operationalErrorCode(error: unknown): AiOperationalErrorCode {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (
    typeof code === 'string' &&
    (/^(08|53|57)[A-Z0-9]{3}$/.test(code) ||
      ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code))
  )
    return 'DATABASE_UNAVAILABLE';
  return 'PIPELINE_FAILED';
}

export function inferenceErrorCode(outcome: unknown): AiOperationalErrorCode | null {
  if (
    !outcome ||
    typeof outcome !== 'object' ||
    !('status' in outcome) ||
    outcome.status !== 'ERROR'
  )
    return null;
  // A single overlong input is not evidence that the model or pipeline is down.
  if ('error_code' in outcome && outcome.error_code === 'INPUT_TOO_LONG') return null;
  const parsed = aiOperationalErrorCode.safeParse(
    'error_code' in outcome ? outcome.error_code : undefined,
  );
  return parsed.success ? parsed.data : 'INFERENCE_FAILED';
}
