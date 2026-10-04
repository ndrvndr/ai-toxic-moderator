import { performance } from 'node:perf_hooks';

import { operationalErrorCode, type AiOperationalFault } from './ai-operational-fault';
import type { AiOperationalStatusReader } from './ai-operational-status-reader';
import type {
  AiOperationalStatusLease,
  AiOperationalStatusStore,
  AiOperationalStatusUpdate,
} from './ai-operational-status-store';

type Entry = {
  lease: AiOperationalStatusLease | null;
  report: AiOperationalStatusUpdate;
  signature: string | null;
  writtenAt: number;
};

/** Runs independently of inference; this loop only reports, never gates dispatch. */
export class AiOperationalStatusCoordinator {
  private readonly entries = new Map<string, Entry>();
  private busy = false;

  constructor(
    private readonly reader: Pick<AiOperationalStatusReader, 'scan'>,
    private readonly store: Pick<AiOperationalStatusStore, 'claim' | 'publish'>,
    private readonly pipeline: () => {
      selected_run_id: string | null;
      fault: AiOperationalFault | null;
    },
    private readonly clock = () => performance.now(),
  ) {}

  async tick(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.busy) return;
    this.busy = true;
    try {
      const reports = await this.reader.scan(signal);
      if (signal.aborted) return;
      const pipeline = this.pipeline();
      for (let report of reports) {
        if (signal.aborted) return;
        if (report.status === 'ACTIVE') {
          const fault = pipeline.fault;
          if (fault && (fault.run_id === null || fault.run_id === report.run_id)) {
            report = {
              ...report,
              status: 'ERROR',
              reason: 'PROCESSING_FAILED',
              error_code: fault.error_code,
            };
          } else if (pipeline.selected_run_id !== report.run_id) {
            report = {
              channel_id: report.channel_id,
              session_id: null,
              run_id: null,
              status: 'WAITING',
              reason: 'NO_ELIGIBLE_RUN',
              error_code: null,
            };
          }
        }
        await this.publish(report, signal);
      }
    } catch (error) {
      // If the database is unavailable, writes also fail and the last heartbeat ages out.
      // Never fabricate a successful heartbeat or hide the original failure from runtime.
      if (!signal.aborted)
        for (const entry of this.entries.values()) {
          const report: AiOperationalStatusUpdate = {
            ...entry.report,
            status: 'ERROR',
            reason: 'PROCESSING_FAILED',
            error_code: operationalErrorCode(error),
          };
          try {
            await this.publish(report, signal);
          } catch {
            /* Runtime logs a safe failure. */
          }
        }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private async publish(report: AiOperationalStatusUpdate, signal: AbortSignal): Promise<void> {
    const now = this.clock();
    let entry = this.entries.get(report.channel_id);
    if (!entry) {
      entry = { lease: null, report, signature: null, writtenAt: -Infinity };
      this.entries.set(report.channel_id, entry);
    }
    entry.report = report;
    if (!entry.lease) {
      if (now - entry.writtenAt < 10_000 || signal.aborted) return;
      entry.writtenAt = now;
      entry.lease = await this.store.claim(report.channel_id);
      entry.signature = null;
      if (!entry.lease || signal.aborted) return;
    }
    const signature = JSON.stringify(report);
    if (signature === entry.signature && now - entry.writtenAt < 10_000) return;
    if (signal.aborted) return;
    const saved = await this.store.publish(entry.lease, report);
    if (!saved) {
      entry.lease = null;
      entry.signature = null;
      entry.writtenAt = -Infinity;
      return;
    }
    entry.signature = signature;
    entry.writtenAt = this.clock();
  }
}
