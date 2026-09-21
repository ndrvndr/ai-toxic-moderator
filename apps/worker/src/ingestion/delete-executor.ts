import type {
  GoogleTokenStore,
  YoutubeDeleteResult,
  YoutubeModerationAdapter,
} from '@moderator/provider-adapters';
import type { DeleteClaim, DeleteExecution, DeleteExecutionStore } from './delete-execution-store';

/** Resolve current authorization from persisted execution provenance, never caller credentials. */
export interface DeleteEligibility {
  resolve(execution: Readonly<DeleteExecution>): Promise<{ accountId: string } | null>;
}

export type DeleteExecutorResult =
  | {
      status: 'SKIPPED';
      reason: 'CANCELLED' | 'INELIGIBLE' | 'CREDENTIALS_UNAVAILABLE' | 'ALREADY_ATTEMPTED';
    }
  | { status: 'RECORDED'; attemptId: string; result: YoutubeDeleteResult }
  | { status: 'RESULT_NOT_RECORDED'; attemptId: string };

/** One attempt only. Runtime wiring requires a database-backed eligibility implementation. */
export class DeleteExecutor {
  constructor(
    private readonly store: Pick<DeleteExecutionStore, 'ensure' | 'claim' | 'complete'>,
    private readonly eligibility: DeleteEligibility,
    private readonly tokens: Pick<GoogleTokenStore, 'accessToken'>,
    private readonly adapter: Pick<YoutubeModerationAdapter, 'deleteMessage'>,
  ) {}

  async execute(input: {
    planId: string;
    channelId: string;
    sessionId: string;
    ownerId: string;
    signal?: AbortSignal;
  }): Promise<DeleteExecutorResult> {
    if (input.signal?.aborted) return { status: 'SKIPPED', reason: 'CANCELLED' };
    const execution = await this.store.ensure(input.planId, input.channelId, input.sessionId);
    const authorization = await this.eligibility.resolve(execution);
    if (!authorization) return { status: 'SKIPPED', reason: 'INELIGIBLE' };

    let accessToken: string;
    try {
      accessToken = await this.tokens.accessToken(authorization.accountId);
    } catch {
      return { status: 'SKIPPED', reason: 'CREDENTIALS_UNAVAILABLE' };
    }
    if (input.signal?.aborted) return { status: 'SKIPPED', reason: 'CANCELLED' };
    const refreshed = await this.eligibility.resolve(execution);
    if (refreshed?.accountId !== authorization.accountId) {
      return { status: 'SKIPPED', reason: 'INELIGIBLE' };
    }

    const claim = await this.store.claim(execution.id, input.ownerId);
    if (!claim) return { status: 'SKIPPED', reason: 'ALREADY_ATTEMPTED' };

    // The dispatch marker is now committed. Every following exit must preserve its history.
    let authorized = false;
    try {
      const current = await this.eligibility.resolve(claim.execution);
      authorized = current?.accountId === authorization.accountId;
    } catch {
      // An unavailable eligibility check must never authorize a provider request.
    }
    const remaining = Date.parse(claim.deadline_at) - Date.now();
    if (!authorized || input.signal?.aborted || !Number.isFinite(remaining) || remaining <= 0) {
      return this.record(claim, { status: 'NOT_SENT', code: 'REQUEST_CANCELLED' });
    }
    const deadline = AbortSignal.timeout(Math.min(Math.floor(remaining), 300000));
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    let result: YoutubeDeleteResult;
    try {
      result = await this.adapter.deleteMessage({
        accessToken,
        externalMessageId: claim.execution.external_message_id,
        signal,
      });
    } catch {
      // A transport throw cannot prove that YouTube did not receive the request.
      result = {
        status: 'UNKNOWN',
        http_status: null,
        code: signal.aborted ? 'REQUEST_INTERRUPTED' : 'TRANSPORT_ERROR',
      };
    }
    return this.record(claim, result);
  }

  private async record(
    claim: DeleteClaim,
    result: YoutubeDeleteResult,
  ): Promise<DeleteExecutorResult> {
    try {
      if (await this.store.complete(claim, result)) {
        return { status: 'RECORDED', attemptId: claim.attempt_id, result };
      }
    } catch {
      // The commit outcome may be uncertain. Recovery, not redispatch, handles this attempt.
    }
    return { status: 'RESULT_NOT_RECORDED', attemptId: claim.attempt_id };
  }
}
