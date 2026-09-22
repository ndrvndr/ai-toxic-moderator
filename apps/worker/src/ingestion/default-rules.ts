import type { DetectionRule } from '@moderator/moderation-core';

export const DEFAULT_RULES: readonly DetectionRule[] = [
  {
    id: 'id.harassment.direct-insult',
    version: '1',
    category: 'HARASSMENT',
    severity: 2,
    strength: 'STRONG',
    intent: 'DIRECT_INSULT',
    pattern: /\b(?:bodoh|tolol|goblok|idiot)\b/giu,
  },
  {
    id: 'id.gambling.promotion',
    version: '1',
    category: 'GAMBLING',
    severity: 1,
    strength: 'AMBIGUOUS',
    intent: 'GAMBLING_PROMOTION',
    pattern: /\b(?:judi|slot|gacor)\b/giu,
  },
  {
    id: 'generic.suspicious-link',
    version: '1',
    category: 'SUSPICIOUS_LINK',
    severity: 1,
    strength: 'AMBIGUOUS',
    intent: 'SUSPICIOUS_LINK',
    pattern: /(?:https?:\/\/|www\.)\S+/giu,
  },
];
