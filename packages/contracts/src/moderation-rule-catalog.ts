import { z } from 'zod';

import { category } from './moderation-enums';

export const moderationRuleCatalogEntry = z.strictObject({
  rule_id: z.string().min(1).max(128),
  rule_version: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  category,
  severity: z.number().int().min(1).max(4),
  strength: z.enum(['STRONG', 'AMBIGUOUS']),
  supported_actions: z.array(z.enum(['DELETE', 'TIMEOUT', 'BAN'])),
});

export const moderationRuleCatalogResponse = z.strictObject({
  items: z.array(moderationRuleCatalogEntry),
});

export type ModerationRuleCatalogEntry = z.infer<typeof moderationRuleCatalogEntry>;

// Metadata is shared with the worker; detection patterns stay in its implementation.
export const BUILTIN_MODERATION_RULE_CATALOG = Object.freeze(
  moderationRuleCatalogResponse
    .parse({
      items: [
        {
          rule_id: 'id.harassment.direct-insult',
          rule_version: '1',
          name: 'Direct insult',
          category: 'HARASSMENT',
          severity: 2,
          strength: 'STRONG',
          supported_actions: ['DELETE', 'TIMEOUT', 'BAN'],
        },
        {
          rule_id: 'id.gambling.promotion',
          rule_version: '1',
          name: 'Possible gambling promotion',
          category: 'GAMBLING',
          severity: 1,
          strength: 'AMBIGUOUS',
          supported_actions: [],
        },
        {
          rule_id: 'generic.suspicious-link',
          rule_version: '1',
          name: 'Possible suspicious link',
          category: 'SUSPICIOUS_LINK',
          severity: 1,
          strength: 'AMBIGUOUS',
          supported_actions: [],
        },
      ],
    })
    .items.map((entry) =>
      Object.freeze({
        ...entry,
        supported_actions: Object.freeze(entry.supported_actions),
      }),
    ),
);
