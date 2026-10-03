import { z } from 'zod';

import { moderationTimeoutDuration } from './moderation-settings';

/** Shared canonical form for literal matching and duplicate detection. */
export function normalizeBlacklistPattern(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

const literalPattern = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
    'Control and format characters are not allowed.',
  )
  .transform(normalizeBlacklistPattern)
  .pipe(z.string().min(1).max(253));

const reference = {
  id: z.uuid().transform((value) => value.toLowerCase()),
  enabled: z.boolean(),
  match_type: z.enum(['WORD', 'PHRASE', 'DOMAIN']),
  pattern: literalPattern,
};

// Literal patterns are never executable regular expressions. Every action deletes
// the matched message; timeout and ban additionally target its verified author.
export const customBlacklistRule = z
  .discriminatedUnion('action', [
    z.strictObject({ ...reference, action: z.literal('DELETE') }),
    z.strictObject({
      ...reference,
      action: z.literal('DELETE_TIMEOUT'),
      duration_seconds: moderationTimeoutDuration,
    }),
    z.strictObject({ ...reference, action: z.literal('DELETE_BAN') }),
  ])
  .superRefine((rule, context) => {
    if (rule.match_type === 'WORD' && !/^[\p{L}\p{M}\p{N}_]+$/u.test(rule.pattern)) {
      context.addIssue({
        code: 'custom',
        path: ['pattern'],
        message:
          'Word patterns must contain one word. Use phrase matching for punctuation or spaces.',
      });
    }

    if (rule.match_type === 'DOMAIN') {
      const labels = rule.pattern.split('.');
      const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
      const topLevel = labels[labels.length - 1] ?? '';
      if (
        labels.length < 2 ||
        labels.some((value) => !label.test(value)) ||
        !/^[a-z][a-z0-9-]*$/.test(topLevel)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['pattern'],
          message: 'Provide an ASCII domain without a scheme, port, path, wildcard, or IP address.',
        });
      }
    }
  });

export const customBlacklistConfiguration = z
  .strictObject({
    schema_version: z.literal(1),
    enabled: z.boolean(),
    rules: z.array(customBlacklistRule).max(100),
  })
  .superRefine((configuration, context) => {
    const ids = new Set<string>();
    const patterns = new Set<string>();
    configuration.rules.forEach((rule, index) => {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'id'],
          message: 'Each blacklist entry must have a unique ID.',
        });
      }
      ids.add(rule.id);

      const key = JSON.stringify([rule.match_type, rule.pattern]);
      if (patterns.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'pattern'],
          message: 'Each matching mode and normalized pattern can select only one action.',
        });
      }
      patterns.add(key);
    });
  });

export type CustomBlacklistRule = z.infer<typeof customBlacklistRule>;
export type CustomBlacklistConfiguration = z.infer<typeof customBlacklistConfiguration>;
