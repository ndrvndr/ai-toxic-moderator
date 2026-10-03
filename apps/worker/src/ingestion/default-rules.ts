import { BUILTIN_MODERATION_RULE_CATALOG } from '@moderator/contracts';
import type { DetectionRule } from '@moderator/moderation-core';

const implementations: Record<string, Pick<DetectionRule, 'intent' | 'pattern'>> = {
  'id.harassment.direct-insult': {
    intent: 'DIRECT_INSULT',
    pattern: /\b(?:bodoh|tolol|goblok|idiot)\b/giu,
  },
  'id.gambling.promotion': {
    intent: 'GAMBLING_PROMOTION',
    pattern: /\b(?:judi|slot|gacor)\b/giu,
  },
  'generic.suspicious-link': {
    intent: 'SUSPICIOUS_LINK',
    pattern: /(?:https?:\/\/|www\.)\S+/giu,
  },
};

export const DEFAULT_RULES: readonly DetectionRule[] = BUILTIN_MODERATION_RULE_CATALOG.map(
  (rule) => {
    const implementation = implementations[rule.rule_id];
    if (!implementation) throw new Error('Built-in rule implementation is missing.');
    return {
      id: rule.rule_id,
      version: rule.rule_version,
      category: rule.category,
      severity: rule.severity,
      strength: rule.strength,
      ...implementation,
    };
  },
);
