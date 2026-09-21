import type {
  GoogleTokenStore,
  YoutubeBanAdapter,
  YoutubeBanResult,
} from '@moderator/provider-adapters';
import type { BanClaim, BanExecution, BanExecutionStore } from './ban-execution-store';

/** Resolve current authorization from persisted execution provenance, never caller credentials. */
export interface BanEligibility {
  resolve(execution: Readonly<BanExecution>): Promise<{ accountId: string } | null>;
}

export type BanExecutorResult =
  | {
      status: 'SKIPPED';
      reason: 'CANCELLED' | 'INELIGIBLE' | 'CREDENTIALS_UNAVAILABLE' | 'ALREADY_ATTEMPTED';
    }
  | { status: 'RECORDED'; attemptId: string; result: YoutubeBanResult }
  | { status: 'RESULT_NOT_RECORDED'; attemptId: string };

/** Single attempt with authorization rechecks. Not yet wired into the worker runtime. */
export class BanExecutor {
  constructor(
    private readonly store: Pick<BanExecutionStore, 'ensure' | 'claim' | 'complete'>,
    private readonly eligibility: BanEligibility,
    private readonly tokens: Pick<GoogleTokenStore, 'accessToken'>,
    private readonly adapter: Pick<YoutubeBanAdapter, 'banUser'>,
  ) {}

  async execute(input: {
    planId: string;
    channelId: string;
    sessionId: string;
    ownerId: string;
    signal?: AbortSignal;
  }): Promise<BanExecutorResult> {
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
    let result: YoutubeBanResult;
    try {
      result = await this.adapter.banUser({
        accessToken,
        liveChatId: claim.execution.live_chat_id,
        authorChannelId: claim.execution.author_channel_id,
        ...(claim.execution.action === 'TIMEOUT'
          ? {
              action: 'TIMEOUT' as const,
              durationSeconds: Number(claim.execution.duration_seconds),
            }
          : { action: 'BAN' as const }),
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

  private async record(claim: BanClaim, result: YoutubeBanResult): Promise<BanExecutorResult> {
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
