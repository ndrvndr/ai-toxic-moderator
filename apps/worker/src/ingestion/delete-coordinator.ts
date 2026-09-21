import { randomUUID } from 'node:crypto';
import type { DeleteCandidateStore } from './delete-candidate-store';
import type { DeleteExecutor } from './delete-executor';

export class DeleteCoordinator {
  private cursor: string | null = null;
  private busy = false;
  private readonly ownerId = randomUUID();

  constructor(
    private readonly candidates: Pick<DeleteCandidateStore, 'next'>,
    private readonly executor: Pick<DeleteExecutor, 'execute'>,
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
      // Advance even when eligibility fails, so a blocked plan cannot starve later plans.
      this.cursor = candidate.planId;
      if (signal.aborted || !this.isEnabled()) return;
      const result = await this.executor.execute({ ...candidate, ownerId: this.ownerId, signal });
      if (result.status === 'RESULT_NOT_RECORDED') {
        console.error(
          'Deletion result could not be recorded. The attempt must not be redispatched.',
        );
      }
    } finally {
      this.busy = false;
    }
  }
}
