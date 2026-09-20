import { messageInput, signal, type MessageInput, type Signal } from '@moderator/contracts';

export type DetectionRule = {
  id: string;
  version: string;
  category: Signal['category'];
  severity: number;
  strength: Signal['strength'];
  intent: string;
  pattern: RegExp;
};

function findMatches(pattern: RegExp, text: string) {
  const flags = `${pattern.flags.replace(/[gy]/g, '')}g`;
  const matcher = new RegExp(pattern.source, flags);
  const matches: Array<{ text: string; start: number; end: number }> = [];

  for (const match of text.matchAll(matcher)) {
    const value = match[0];

    if (!value || match.index === undefined) continue;

    matches.push({
      text: value,
      start: match.index,
      end: match.index + value.length,
    });
  }

  return matches;
}

export class RuleDetectionEngine {
  private readonly rules: readonly DetectionRule[];

  constructor(rules: readonly DetectionRule[]) {
    this.rules = [...rules];
  }

  async detect(input: MessageInput): Promise<readonly Signal[]> {
    const message = messageInput.parse(input);
    const signals: Signal[] = [];

    for (const rule of this.rules) {
      const matches = findMatches(rule.pattern, message.raw_text);

      if (matches.length === 0) continue;

      signals.push(
        signal.parse({
          rule_id: rule.id,
          rule_version: rule.version,
          category: rule.category,
          severity: rule.severity,
          strength: rule.strength,
          confidence: null,
          intent: rule.intent,
          evidence: matches.map((match) => ({
            representation_type: 'RAW',
            matched_text: match.text,
            normalized_span: {
              start: match.start,
              end: match.end,
            },
            raw_span: {
              start: match.start,
              end: match.end,
            },
            mapping_quality: 'EXACT',
          })),
        }),
      );
    }

    return signals.sort(
      (left, right) => right.severity - left.severity || left.rule_id.localeCompare(right.rule_id),
    );
  }
}
