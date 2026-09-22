import { randomUUID } from 'node:crypto';

import type { BanCandidateStore } from './ban-candidate-store';
import type { BanExecutor } from './ban-executor';

export class BanCoordinator {
  private cursor: string | null = null;
  private busy = false;
  private readonly ownerId = randomUUID();

  constructor(
    private readonly candidates: Pick<BanCandidateStore, 'next'>,
    private readonly executor: Pick<BanExecutor, 'execute'>,
    private readonly isEnabled: () => boolean,
  ) {}

  async tick(signal: AbortSignal): Promise<void> {
    if (this.busy || signal.aborted || !this.isEnabled()) return;

    this.busy = true;

    try {
      const candidate = await this.candidates.next(this.cursor);

      if (!candidate) {
        this.cursor = null;
        return;
      }

      // Skipped plans must not prevent later candidates from being checked.
      this.cursor = candidate.planId;

      if (signal.aborted || !this.isEnabled()) return;

      const result = await this.executor.execute({
        ...candidate,
        ownerId: this.ownerId,
        signal,
      });

      if (result.status === 'RESULT_NOT_RECORDED') {
        console.error(
          'Timeout or ban result could not be recorded. Do not redispatch the attempt.',
        );
      }
    } finally {
      this.busy = false;
    }
  }
}
