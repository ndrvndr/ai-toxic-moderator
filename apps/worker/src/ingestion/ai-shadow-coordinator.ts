import { aiShadowIdentity, aiShadowResult, uuid } from '@moderator/contracts';

import type { AiShadowCandidateReader } from './ai-shadow-candidate-reader';
import type { AiShadowResultWriter } from './ai-shadow-result-writer';
import type { AiShadowRunner } from './ai-shadow-runner';

export class AiShadowCoordinator {
  private busy = false;

  constructor(
    private readonly reader: Pick<AiShadowCandidateReader, 'next'>,
    private readonly runner: Pick<AiShadowRunner, 'predict'>,
    private readonly writer: Pick<AiShadowResultWriter, 'save'>,
  ) {}

  async tick(runId: string, signal: AbortSignal) {
    if (signal.aborted) return { kind: 'CANCELLED' as const };
    if (this.busy) return { kind: 'BUSY' as const };
    uuid.parse(runId);
    this.busy = true;
    try {
      const candidate = await this.reader.next(runId);
      if (signal.aborted) return { kind: 'CANCELLED' as const };
      if (!candidate) return { kind: 'IDLE' as const };
      const identity = aiShadowIdentity.parse(candidate.identity);
      if (identity.run_id !== runId) throw new Error('AI candidate belongs to another run.');

      let output;
      try {
        output = await this.runner.predict(identity, candidate.text);
      } catch (error) {
        // Backpressure is not a terminal result for this observation.
        if (error instanceof Error && error.message === 'AI_ADAPTER_BUSY') {
          return { kind: 'BUSY' as const };
        }
        throw error;
      }
      if (signal.aborted) return { kind: 'CANCELLED' as const };
      const result = aiShadowResult.parse(output);
      if (
        Object.entries(identity).some(
          ([key, value]) => result[key as keyof typeof result] !== value,
        )
      ) {
        throw new Error('AI shadow output belongs to another identity.');
      }
      const saved = await this.writer.save(result);
      return {
        kind: saved.inserted ? ('INSERTED' as const) : ('EXISTING' as const),
        observation_id: identity.observation_id,
        status: saved.result.status,
      };
    } finally {
      this.busy = false;
    }
  }
}
