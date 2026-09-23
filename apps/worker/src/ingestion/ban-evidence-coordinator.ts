import { performance } from 'node:perf_hooks';

import type { BanEvidenceReader } from './ban-evidence-reader';
import type { BanEvidenceStore } from './ban-evidence-store';

export class BanEvidenceCoordinator {
  private busy = false;
  private attemptCursor: string | null = null;
  private activeAttempt: string | null = null;
  private observationCursor: string | null = null;
  private resumeAt = 0;

  constructor(
    private readonly reader: Pick<BanEvidenceReader, 'nextAttempt' | 'read'>,
    private readonly store: Pick<BanEvidenceStore, 'save'>,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async tick(signal: AbortSignal): Promise<void> {
    if (this.busy || signal.aborted || this.now() < this.resumeAt) return;

    this.busy = true;

    try {
      if (this.activeAttempt === null) {
        const attemptId = await this.reader.nextAttempt(this.attemptCursor);

        if (signal.aborted) return;

        if (attemptId === null) {
          this.attemptCursor = null;
          this.observationCursor = null;
          this.resumeAt = this.now() + 30_000;
          return;
        }

        this.activeAttempt = attemptId;
      }

      const attemptId = this.activeAttempt;
      const page = await this.reader.read(attemptId, this.observationCursor, 100);

      if (signal.aborted) return;

      if (page !== null) {
        if (page.attemptId !== attemptId) {
          throw new Error('Evidence page belongs to another attempt.');
        }

        for (const match of page.matches) {
          if (signal.aborted) return;

          await this.store.save(attemptId, match.observationId);
        }

        if (signal.aborted) return;

        if (page.nextCursor !== null) {
          if (page.nextCursor === this.observationCursor) {
            throw new Error('Evidence pagination did not advance.');
          }

          this.observationCursor = page.nextCursor;
          return;
        }
      }

      this.attemptCursor = attemptId;
      this.activeAttempt = null;
      this.observationCursor = null;
    } finally {
      this.busy = false;
    }
  }
}
