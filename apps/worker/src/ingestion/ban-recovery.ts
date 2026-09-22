import type { BanExecutionStore } from './ban-execution-store';

/** Database-only recovery does not authorize another provider request. */
export class BanRecovery {
  private busy = false;

  constructor(private readonly store: Pick<BanExecutionStore, 'recoverExpired'>) {}

  async tick(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.busy) return;

    this.busy = true;

    try {
      // Drain an in-flight update before the runtime closes the database pool.
      await this.store.recoverExpired(100);
    } finally {
      this.busy = false;
    }
  }
}
