import type { YoutubeBanEventEvidence } from '@moderator/provider-adapters';

export type UnknownBanAttempt = {
  status: 'UNKNOWN';
  action: 'TIMEOUT' | 'BAN';
  liveChatId: string;
  targetChannelId: string;
  moderatorChannelId: string;
  durationSeconds: string | null;
  startedAt: string;
  deadlineAt: string;
};

export type BanEvidenceMatch =
  | { matched: true; attribution: 'UNPROVEN' }
  | {
      matched: false;
      reason:
        | 'INVALID_ATTEMPT'
        | 'LIVE_CHAT_MISMATCH'
        | 'TARGET_MISMATCH'
        | 'MODERATOR_MISMATCH'
        | 'ACTION_MISMATCH'
        | 'DURATION_MISMATCH'
        | 'OUTSIDE_ATTEMPT_WINDOW';
    };

/**
 * Selects candidate evidence only.
 * A matching event does not prove that this application caused the action.
 */
export function matchBanEvidence(
  attempt: UnknownBanAttempt,
  evidence: YoutubeBanEventEvidence,
): BanEvidenceMatch {
  const startedAt = Date.parse(attempt.startedAt);
  const deadlineAt = Date.parse(attempt.deadlineAt);
  const publishedAt = Date.parse(evidence.publishedAt);

  if (
    attempt.status !== 'UNKNOWN' ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(deadlineAt) ||
    deadlineAt <= startedAt ||
    !attempt.liveChatId ||
    !attempt.targetChannelId ||
    !attempt.moderatorChannelId ||
    (attempt.action === 'TIMEOUT'
      ? !/^[1-9][0-9]*$/.test(attempt.durationSeconds ?? '')
      : attempt.durationSeconds !== null)
  ) {
    return { matched: false, reason: 'INVALID_ATTEMPT' };
  }

  if (evidence.liveChatId !== attempt.liveChatId) {
    return { matched: false, reason: 'LIVE_CHAT_MISMATCH' };
  }

  if (evidence.targetChannelId !== attempt.targetChannelId) {
    return { matched: false, reason: 'TARGET_MISMATCH' };
  }

  if (evidence.moderatorChannelId !== attempt.moderatorChannelId) {
    return { matched: false, reason: 'MODERATOR_MISMATCH' };
  }

  if (evidence.action !== attempt.action) {
    return { matched: false, reason: 'ACTION_MISMATCH' };
  }

  if (evidence.durationSeconds !== attempt.durationSeconds) {
    return { matched: false, reason: 'DURATION_MISMATCH' };
  }

  if (!Number.isFinite(publishedAt) || publishedAt < startedAt || publishedAt > deadlineAt) {
    return { matched: false, reason: 'OUTSIDE_ATTEMPT_WINDOW' };
  }

  return { matched: true, attribution: 'UNPROVEN' };
}
