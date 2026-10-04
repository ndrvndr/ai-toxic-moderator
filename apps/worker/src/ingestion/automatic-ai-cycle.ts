import type { AppConfig } from '@moderator/config';
import { uuid } from '@moderator/contracts';
import type { createPool } from '@moderator/persistence';

import { createAiActionDecisionCycle } from './ai-action-decision-cycle';
import { createAiActionPlanCycle } from './ai-action-plan-cycle';
import {
  inferenceErrorCode,
  operationalErrorCode,
  type AiOperationalFault,
} from './ai-operational-fault';
import { createAiShadowCycle } from './ai-shadow-cycle';
import { AiShadowRunner } from './ai-shadow-runner';
import { AutomaticAiRunReader } from './automatic-ai-run-reader';
import { LASKAR_ADAPTER_VERSION, LASKAR_MODEL_ID } from './laskar-shadow-adapter';

type Cycle = { tick(signal: AbortSignal): Promise<unknown> };
type RunCycles = { inference: Cycle; decisions: Cycle; plans: Cycle };
type Status = 'SELECTED' | 'IDLE' | 'CAPACITY_EXCEEDED' | 'ERROR';
type AutomaticConfig = Pick<
  AppConfig,
  | 'AI_AUTOMATIC_ENABLED'
  | 'AI_SHADOW_MODEL_REVISION'
  | 'AI_SHADOW_CACHE_DIRECTORY'
  | 'AI_SHADOW_STARTUP_TIMEOUT_MS'
  | 'AI_SHADOW_INFERENCE_TIMEOUT_MS'
>;
type Runner = Pick<AiShadowRunner, 'predict' | 'dispose'>;

/** One serial AI pipeline shares one runner across successive monitoring runs. */
export class AutomaticAiCycle {
  private selectedRun: string | null = null;
  private cycles: { runId: string; work: RunCycles } | null = null;
  private active: Promise<unknown> | null = null;
  private closed = false;
  private disposal: Promise<void> | null = null;
  private lastStatus: string | null = null;
  private fault: AiOperationalFault | null = null;

  constructor(
    private readonly reader: Pick<AutomaticAiRunReader, 'next'>,
    private readonly createCycles: (runId: string) => RunCycles,
    private readonly runner: Pick<Runner, 'dispose'>,
    private readonly report: (status: Status) => void = () => undefined,
  ) {}

  allowedRunId(): string | null {
    return this.closed ? null : this.selectedRun;
  }

  operationalState(): { selected_run_id: string | null; fault: AiOperationalFault | null } {
    return { selected_run_id: this.allowedRunId(), fault: this.fault ? { ...this.fault } : null };
  }

  tick(signal: AbortSignal): Promise<unknown> {
    if (this.closed || signal.aborted) {
      this.selectedRun = null;
      return Promise.resolve({ kind: 'CANCELLED' });
    }
    if (this.active) return Promise.resolve({ kind: 'BUSY' });
    const work = this.process(signal).finally(() => {
      this.active = null;
    });
    this.active = work;
    return work;
  }

  private async select(signal: AbortSignal, expectedRun?: string): Promise<string | null> {
    if (this.closed || signal.aborted) {
      this.selectedRun = null;
      return null;
    }
    const selection = await this.reader.next(signal);
    if (this.closed || signal.aborted || selection.kind === 'CANCELLED') {
      this.selectedRun = null;
      return null;
    }
    if (selection.kind !== 'SELECTED') {
      this.selectedRun = null;
      this.cycles = null;
      this.status(selection.kind);
      return null;
    }
    const runId = uuid.parse(selection.run_id).toLowerCase();
    if (expectedRun && runId !== expectedRun) {
      // Finish no further stages for the old run; construct the new scope on the next tick.
      this.selectedRun = null;
      this.cycles = null;
      return null;
    }
    return runId;
  }

  private async process(signal: AbortSignal): Promise<unknown> {
    let currentRun: string | null = null;
    try {
      const runId = await this.select(signal);
      currentRun = runId;
      if (this.closed || signal.aborted) {
        this.selectedRun = null;
        return { kind: 'CANCELLED' };
      }
      if (!runId) return { kind: 'IDLE' };
      let scoped = this.cycles;
      if (!scoped || scoped.runId !== runId) {
        this.selectedRun = null;
        scoped = { runId, work: this.createCycles(runId) };
        this.cycles = scoped;
      }
      const cycles = scoped.work;
      this.selectedRun = runId;
      this.status('SELECTED', runId);
      const outcome = await cycles.inference.tick(signal);
      const inferenceFailure = inferenceErrorCode(outcome);
      if (inferenceFailure && !signal.aborted && !this.closed) {
        this.fault = { run_id: runId, error_code: inferenceFailure, source: 'INFERENCE' };
      } else if (
        outcome &&
        typeof outcome === 'object' &&
        'status' in outcome &&
        outcome.status === 'SUCCEEDED'
      ) {
        this.fault = null;
      }
      const afterInference = await this.select(signal, runId);
      if (!afterInference || this.closed || signal.aborted) {
        this.selectedRun = null;
        return { kind: 'SCOPE_CHANGED' };
      }
      await cycles.decisions.tick(signal);
      const afterDecision = await this.select(signal, runId);
      if (!afterDecision || this.closed || signal.aborted) {
        this.selectedRun = null;
        return { kind: 'SCOPE_CHANGED' };
      }
      await cycles.plans.tick(signal);
      // Revoke dispatch promptly if stop/access/capacity changed during materialization.
      const afterPlans = await this.select(signal, runId);
      if (!afterPlans || this.closed || signal.aborted) {
        this.selectedRun = null;
        return { kind: 'SCOPE_CHANGED' };
      }
      if (this.fault?.source === 'PIPELINE' || this.fault?.run_id !== runId) this.fault = null;
      return { kind: 'PROCESSED', run_id: runId };
    } catch (error) {
      this.selectedRun = null;
      if (!this.closed && !signal.aborted) {
        this.fault = {
          run_id: currentRun,
          error_code: operationalErrorCode(error),
          source: 'PIPELINE',
        };
        this.status('ERROR');
      }
      throw error;
    }
  }

  private status(status: Status, runId: string | null = null): void {
    const key = `${status}:${runId ?? ''}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.report(status);
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.selectedRun = null;
    this.disposal ??= (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.runner.dispose()),
        this.active,
      ]);
      this.cycles = null;
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('Automatic AI cleanup failed.');
      }
    })();
    return this.disposal;
  }
}

export function createAutomaticAiCycle(
  config: AutomaticConfig,
  pool: ReturnType<typeof createPool>,
  createRunner: (options: ConstructorParameters<typeof AiShadowRunner>[0]) => Runner = (options) =>
    new AiShadowRunner(options),
  report: (status: Status) => void = (status) => {
    if (status === 'CAPACITY_EXCEEDED') {
      console.warn('Automatic AI paused: more than one eligible livestream is active.');
    } else if (status === 'ERROR') {
      console.error('Automatic AI cycle failed. Check model configuration and database access.');
    } else if (status === 'IDLE') {
      console.log('Automatic AI is waiting for an eligible run with captured enabled settings.');
    } else {
      console.log('Automatic AI selected an active run with matching captured model settings.');
    }
  },
): AutomaticAiCycle | undefined {
  if (!config.AI_AUTOMATIC_ENABLED) return undefined;
  const reader = new AutomaticAiRunReader(pool, {
    model_id: LASKAR_MODEL_ID,
    model_revision: config.AI_SHADOW_MODEL_REVISION,
    model_variant: 'INT8',
    adapter_version: LASKAR_ADAPTER_VERSION,
  });
  // Native initialization is lazy, and this single runner survives run changes.
  const runner = createRunner({
    cacheDirectory: config.AI_SHADOW_CACHE_DIRECTORY,
    revision: config.AI_SHADOW_MODEL_REVISION,
    startupMs: config.AI_SHADOW_STARTUP_TIMEOUT_MS,
    inferenceMs: config.AI_SHADOW_INFERENCE_TIMEOUT_MS,
  });
  return new AutomaticAiCycle(
    reader,
    (runId) => {
      const scoped = { ...config, AI_SHADOW_ENABLED: true, AI_SHADOW_RUN_ID: runId };
      const inference = createAiShadowCycle(scoped, pool, () => runner);
      const decisions = createAiActionDecisionCycle(scoped, pool);
      const plans = createAiActionPlanCycle(scoped, pool);
      if (!inference || !decisions || !plans) throw new Error('AI pipeline is unavailable.');
      return { inference, decisions, plans };
    },
    runner,
    report,
  );
}
