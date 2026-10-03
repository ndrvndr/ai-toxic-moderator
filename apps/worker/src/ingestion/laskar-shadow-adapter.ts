import {
  aiShadowIdentity,
  aiShadowResult,
  type AiShadowIdentity,
  type AiShadowResult,
} from '@moderator/contracts';
import { performance } from 'node:perf_hooks';

export const LASKAR_MODEL_ID = 'laskar-ks/toxic-guardrail-minilm-id-en';
export const LASKAR_ADAPTER_VERSION = 'laskar-shadow-1';
export type ShadowObservationIdentity = Pick<
  AiShadowIdentity,
  'channel_id' | 'session_id' | 'observation_id' | 'run_id'
>;
export type LaskarBackend = {
  infer(text: string): Promise<{ logits: number[]; truncated: boolean }>;
  dispose(): Promise<void>;
};

export function normalizeLaskarText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '')
    .replace(/https?:\/\/\S+|www\.\S+/g, ' <url> ')
    .replace(/@\w+/g, ' <user> ')
    .replace(/[\n\t]/g, ' ')
    .replace(/USER/g, ' <user> ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function remapLaskarTokens(ids: BigInt64Array, remap: Int32Array): BigInt64Array {
  return BigInt64Array.from(ids, (id) => {
    const index = Number(id);
    const mapped = remap[index];
    if (!Number.isSafeInteger(index) || index < 0 || mapped === undefined || mapped < 0) {
      throw new Error('Invalid model token mapping.');
    }
    return BigInt(mapped);
  });
}

export function decodeLaskarLogits(
  logits: number[],
  temperature: number,
): { rating: 0 | 2 | 3 | 4; severity_score: number } {
  if (
    logits.length !== 4 ||
    logits.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(temperature) ||
    temperature <= 0
  ) {
    throw new Error('Invalid model logits.');
  }
  const scaled = logits.map((value) => value / temperature);
  if (scaled.some((value) => !Number.isFinite(value))) throw new Error('Invalid scaled logits.');
  const maximum = Math.max(...scaled);
  const exp = scaled.map((value) => Math.exp(value - maximum));
  const sum = exp.reduce((total, value) => total + value, 0);
  const probabilities = exp.map((value) => value / sum);
  const ratings = [0, 2, 3, 4] as const;
  const rating = ratings[probabilities.indexOf(Math.max(...probabilities))];
  if (rating === undefined) throw new Error('Invalid model rating.');
  return {
    rating,
    severity_score: probabilities.reduce((total, value, i) => total + value * ratings[i]!, 0) / 4,
  };
}

export class LaskarShadowAdapter {
  private active: Promise<AiShadowResult> | null = null;
  private closed = false;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly backend: LaskarBackend,
    readonly revision: string,
    private readonly temperature: number,
  ) {
    if (!/^[a-f0-9]{40}$/.test(revision) || !Number.isFinite(temperature) || temperature <= 0) {
      throw new Error('Invalid model identity or temperature.');
    }
  }

  identity(observation: ShadowObservationIdentity): AiShadowIdentity {
    return aiShadowIdentity.parse({
      ...observation,
      model_id: LASKAR_MODEL_ID,
      model_revision: this.revision,
      model_variant: 'INT8',
      adapter_version: LASKAR_ADAPTER_VERSION,
    });
  }

  predict(observation: ShadowObservationIdentity, text: string): Promise<AiShadowResult> {
    const identity = this.identity(observation);
    // Backpressure is a scheduling error, not a terminal result for a queued message.
    if (this.active) return Promise.reject(new Error('AI_ADAPTER_BUSY'));
    const work = this.predictOne(identity, text);
    const tracked = work.finally(() => {
      this.active = null;
    });
    this.active = tracked;
    return tracked;
  }

  private async predictOne(identity: AiShadowIdentity, text: string): Promise<AiShadowResult> {
    const failure = (
      error_code: 'MODEL_UNAVAILABLE' | 'INPUT_TOO_LONG' | 'INFERENCE_FAILED' | 'INVALID_OUTPUT',
    ) =>
      aiShadowResult.parse({
        ...identity,
        status: 'ERROR',
        rating: null,
        severity_score: null,
        truncated: null,
        inference_ms: null,
        error_code,
      });
    if (this.closed) return failure('MODEL_UNAVAILABLE');
    if (typeof text !== 'string' || !text.trim()) return failure('INFERENCE_FAILED');
    if (text.length > 10_000) return failure('INPUT_TOO_LONG');
    const normalized = normalizeLaskarText(text);
    if (!normalized) return failure('INFERENCE_FAILED');
    const started = performance.now();
    let output;
    try {
      output = await this.backend.infer(normalized);
    } catch {
      return failure('INFERENCE_FAILED');
    }
    try {
      const decoded = decodeLaskarLogits(output.logits, this.temperature);
      return aiShadowResult.parse({
        ...identity,
        status: 'SUCCEEDED',
        ...decoded,
        truncated: output.truncated,
        inference_ms: performance.now() - started,
        error_code: null,
      });
    } catch {
      return failure('INVALID_OUTPUT');
    }
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.disposal ??= (async () => {
      if (this.active) await this.active.catch(() => undefined);
      await this.backend.dispose();
    })();
    return this.disposal;
  }
}
