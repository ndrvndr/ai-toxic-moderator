import { signal, type Signal } from '@moderator/contracts';

export type PolicyDecision = {
  outcome: 'ALLOW' | 'REVIEW';
  primary_category: Signal['category'] | null;
  severity: number;
  reason_code: 'NO_RULE_MATCH' | 'CONTEXT_REQUIRED' | 'GAMBLING_PROMOTION' | 'DIRECT_INSULT';
  reason: string;
  signals: readonly Signal[];
};

function reasonCode(intent: string): PolicyDecision['reason_code'] {
  if (intent === 'DIRECT_INSULT') return 'DIRECT_INSULT';
  if (intent === 'GAMBLING_PROMOTION') return 'GAMBLING_PROMOTION';
  return 'CONTEXT_REQUIRED';
}

export class ModerationPolicy {
  evaluate(input: readonly Signal[]): PolicyDecision {
    const signals = signal.array().parse(input);

    if (signals.length === 0) {
      return {
        outcome: 'ALLOW',
        primary_category: null,
        severity: 0,
        reason_code: 'NO_RULE_MATCH',
        reason: 'No configured rule matched this message.',
        signals: [],
      };
    }

    const ordered = [...signals].sort(
      (left, right) => right.severity - left.severity || left.rule_id.localeCompare(right.rule_id),
    );

    const primary = ordered[0]!;

    return {
      outcome: 'REVIEW',
      primary_category: primary.category,
      severity: primary.severity,
      reason_code: reasonCode(primary.intent),
      reason: `The message matched rule ${primary.rule_id} and requires review.`,
      signals: ordered,
    };
  }
}
