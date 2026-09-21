import type { createPool } from '@moderator/persistence';
import { setTimeout as delay } from 'node:timers/promises';

import type { IngestionCoordinator } from './coordinator';

type DatabasePool = ReturnType<typeof createPool>;

export class WorkerRuntime {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly coordinator: Pick<IngestionCoordinator, 'tick'>,
    private readonly pool: Pick<DatabasePool, 'end'>,
    private readonly deletions?: { tick(signal: AbortSignal): Promise<unknown> },
  ) {}

  start(): void {
    if (this.running || this.abort.signal.aborted) return;

    this.running = this.runLoops();
  }

  private async runLoops(): Promise<void> {
    const loops = [this.loop(this.coordinator, 'Ingestion')];
    if (this.deletions) loops.push(this.loop(this.deletions, 'Deletion'));
    // Always drain both loops before the shared database pool can be closed.
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
      await this.running;
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
