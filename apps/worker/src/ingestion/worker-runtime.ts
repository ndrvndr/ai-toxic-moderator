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
  ) {}

  start(): void {
    if (this.running || this.abort.signal.aborted) return;

    this.running = this.loop();
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

  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.coordinator.tick(this.abort.signal);
      } catch {
        if (!this.abort.signal.aborted) {
          console.error(
            'Ingestion cycle failed. Check database connectivity and worker configuration.',
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
