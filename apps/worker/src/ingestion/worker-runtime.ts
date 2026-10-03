import type { createPool } from '@moderator/persistence';
import { setTimeout as delay } from 'node:timers/promises';

import type { IngestionCoordinator } from './coordinator';

type DatabasePool = ReturnType<typeof createPool>;

type WorkerCycle = {
  tick(signal: AbortSignal): Promise<unknown>;
};

type BanCycles = {
  dispatch?: WorkerCycle;
  recovery: WorkerCycle;
  evidence?: WorkerCycle;
};

type ShadowCycle = WorkerCycle & { dispose(): Promise<void> };

export class WorkerRuntime {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly coordinator: Pick<IngestionCoordinator, 'tick'>,
    private readonly pool: Pick<DatabasePool, 'end'>,
    private readonly deletions?: WorkerCycle,
    private readonly recovery?: WorkerCycle,
    private readonly bans?: BanCycles,
    private readonly shadow?: ShadowCycle,
  ) {}

  start(): void {
    if (this.running || this.abort.signal.aborted) return;

    this.running = this.runLoops();
  }

  private async runLoops(): Promise<void> {
    const loops = [this.loop(this.coordinator, 'Ingestion')];

    if (this.deletions) {
      loops.push(this.loop(this.deletions, 'Deletion'));
    }

    if (this.recovery) {
      loops.push(this.loop(this.recovery, 'Deletion recovery'));
    }

    if (this.bans?.dispatch) {
      loops.push(this.loop(this.bans.dispatch, 'Timeout and ban'));
    }

    if (this.bans) {
      loops.push(this.loop(this.bans.recovery, 'Timeout and ban recovery'));
    }

    if (this.bans?.evidence) {
      loops.push(this.loop(this.bans.evidence, 'Moderation evidence'));
    }

    if (this.shadow) {
      loops.push(this.loop(this.shadow, 'AI shadow'));
    }

    // Every loop must finish before the shared pool closes.
    const results = await Promise.allSettled(loops);

    if (results.some((result) => result.status === 'rejected')) {
      console.error('A worker loop stopped unexpectedly.');
    }
  }

  onApplicationShutdown(): Promise<void> {
    this.stopping ??= this.stop();
    return this.stopping;
  }

  private async stop(): Promise<void> {
    this.abort.abort();

    try {
      // Dispose first so native inference cannot delay shutdown until its full deadline.
      // Drain both inference cleanup and database work before closing the shared pool.
      const results = await Promise.allSettled([
        this.running,
        Promise.resolve().then(() => this.shadow?.dispose()),
      ]);
      if (results.some((result) => result.status === 'rejected')) {
        console.error('Worker shutdown encountered a cleanup failure.');
      }
    } finally {
      await this.pool.end();
    }
  }

  private async loop(
    coordinator: { tick(signal: AbortSignal): Promise<unknown> },
    label: string,
  ): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await coordinator.tick(this.abort.signal);
      } catch {
        if (!this.abort.signal.aborted) {
          console.error(
            `${label} cycle failed. Check database connectivity and worker configuration.`,
          );
        }
      }

      if (this.abort.signal.aborted) break;

      try {
        await delay(1000, undefined, { signal: this.abort.signal });
      } catch (error) {
        if (!this.abort.signal.aborted) throw error;
      }
    }
  }
}
