import type { AppConfig } from '@moderator/config';
import { aiActionDecisionSave, uuid } from '@moderator/contracts';
import { transaction, type createPool } from '@moderator/persistence';
import { AiActionDecisionCandidateReader } from './ai-action-decision-candidate-reader';
import { AiActionDecisionStore } from './ai-action-decision-store';
import { LASKAR_ADAPTER_VERSION, LASKAR_MODEL_ID } from './laskar-shadow-adapter';

type DecisionConfig = Pick<
  AppConfig,
  'AI_SHADOW_ENABLED' | 'AI_SHADOW_RUN_ID' | 'AI_SHADOW_MODEL_REVISION'
>;

export class AiActionDecisionCycle {
  private readonly runId: string;
  private busy = false;

  constructor(
    runId: string,
    private readonly reader: Pick<AiActionDecisionCandidateReader, 'next'>,
    private readonly pool: ReturnType<typeof createPool>,
    private readonly store: Pick<AiActionDecisionStore, 'save'> = new AiActionDecisionStore(),
  ) {
    this.runId = uuid.parse(runId).toLowerCase();
  }

  async tick(signal: AbortSignal) {
    if (signal.aborted) return { kind: 'CANCELLED' as const };
    if (this.busy) return { kind: 'BUSY' as const };
    this.busy = true;
    try {
      const candidate = await this.reader.next(this.runId, signal);
      if (signal.aborted) return { kind: 'CANCELLED' as const };
      if (!candidate) return { kind: 'IDLE' as const };
      const input = aiActionDecisionSave.parse(candidate);
      if (input.run_id !== this.runId)
        throw new Error('AI decision candidate belongs to another run.');
      // The store reads committed model output; inference never holds this transaction open.
      const saved = await transaction(this.pool, async (client) => {
        if (signal.aborted) return null;
        return this.store.save(client, input);
      });
      if (!saved) return { kind: 'CANCELLED' as const };
      return {
        kind: saved.reused ? ('EXISTING' as const) : ('INSERTED' as const),
        observation_id: input.observation_id,
        reason_code: saved.decision.reason_code,
      };
    } finally {
      this.busy = false;
    }
  }
}

export function createAiActionDecisionCycle(
  config: DecisionConfig,
  pool: ReturnType<typeof createPool>,
): AiActionDecisionCycle | undefined {
  // Audit is scoped to the existing opt-in shadow run. This does not enable AI dispatch.
  if (!config.AI_SHADOW_ENABLED) return undefined;
  const reader = new AiActionDecisionCandidateReader(pool, {
    model_id: LASKAR_MODEL_ID,
    model_revision: config.AI_SHADOW_MODEL_REVISION,
    model_variant: 'INT8',
    adapter_version: LASKAR_ADAPTER_VERSION,
  });
  return new AiActionDecisionCycle(config.AI_SHADOW_RUN_ID, reader, pool);
}
