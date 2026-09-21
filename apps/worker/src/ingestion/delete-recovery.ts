import type { DeleteExecutionStore } from './delete-execution-store';

/** Database-only recovery remains active even when new deletion dispatch is disabled. */
export class DeleteRecovery {
  private busy = false;

  constructor(private readonly store: Pick<DeleteExecutionStore, 'recoverExpired'>) {}

  async tick(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.busy) return;
    this.busy = true;
    try {
      // Finish an in-flight database update before runtime closes the shared pool.
      await this.store.recoverExpired(100);
    } finally {
      this.busy = false;
    }
  }
}
