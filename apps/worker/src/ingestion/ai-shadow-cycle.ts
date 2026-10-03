import type { AppConfig } from '@moderator/config';
import { uuid } from '@moderator/contracts';
import type { createPool } from '@moderator/persistence';

import { AiShadowCandidateReader } from './ai-shadow-candidate-reader';
import { AiShadowCoordinator } from './ai-shadow-coordinator';
import { AiShadowResultWriter } from './ai-shadow-result-writer';
import { AiShadowRunner } from './ai-shadow-runner';
import { LASKAR_ADAPTER_VERSION, LASKAR_MODEL_ID } from './laskar-shadow-adapter';

type ShadowConfig = Pick<
  AppConfig,
  | 'AI_SHADOW_ENABLED'
  | 'AI_SHADOW_RUN_ID'
  | 'AI_SHADOW_MODEL_REVISION'
  | 'AI_SHADOW_CACHE_DIRECTORY'
  | 'AI_SHADOW_STARTUP_TIMEOUT_MS'
  | 'AI_SHADOW_INFERENCE_TIMEOUT_MS'
>;
type ShadowRunner = Pick<AiShadowRunner, 'predict' | 'dispose'>;

export class AiShadowCycle {
  private closed = false;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly runId: string,
    private readonly coordinator: Pick<AiShadowCoordinator, 'tick'>,
    private readonly runner: Pick<AiShadowRunner, 'dispose'>,
  ) {
    uuid.parse(runId);
  }

  async tick(signal: AbortSignal) {
    if (this.closed || signal.aborted) return { kind: 'CANCELLED' as const };
    return this.coordinator.tick(this.runId, signal);
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.disposal ??= this.runner.dispose();
    return this.disposal;
  }
}

export function createAiShadowCycle(
  config: ShadowConfig,
  pool: ReturnType<typeof createPool>,
  createRunner: (options: ConstructorParameters<typeof AiShadowRunner>[0]) => ShadowRunner = (
    options,
  ) => new AiShadowRunner(options),
): AiShadowCycle | undefined {
  // Disabled shadow mode does not construct a runner or touch local model artifacts.
  if (!config.AI_SHADOW_ENABLED) return undefined;
  uuid.parse(config.AI_SHADOW_RUN_ID);
  const reader = new AiShadowCandidateReader(pool, {
    model_id: LASKAR_MODEL_ID,
    model_revision: config.AI_SHADOW_MODEL_REVISION,
    model_variant: 'INT8',
    adapter_version: LASKAR_ADAPTER_VERSION,
  });
  const runner = createRunner({
    cacheDirectory: config.AI_SHADOW_CACHE_DIRECTORY,
    revision: config.AI_SHADOW_MODEL_REVISION,
    startupMs: config.AI_SHADOW_STARTUP_TIMEOUT_MS,
    inferenceMs: config.AI_SHADOW_INFERENCE_TIMEOUT_MS,
  });
  return new AiShadowCycle(
    config.AI_SHADOW_RUN_ID,
    new AiShadowCoordinator(reader, runner, new AiShadowResultWriter(pool)),
    runner,
  );
}
