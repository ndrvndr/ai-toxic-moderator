import { z } from 'zod';

const ruleReference = {
  rule_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  rule_version: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  minimum_severity: z.number().int().min(1).max(4),
};

// This application configuration limit is not a claim about provider limits.
export const moderationTimeoutDuration = z.number().int().min(1).max(86_400);

export const moderationSettingsRule = z.discriminatedUnion('action', [
  z.strictObject({ ...ruleReference, action: z.literal('DELETE') }),
  z.strictObject({
    ...ruleReference,
    action: z.literal('TIMEOUT'),
    duration_seconds: moderationTimeoutDuration,
  }),
  z.strictObject({ ...ruleReference, action: z.literal('BAN') }),
]);

export const moderationSettingsConfiguration = z
  .strictObject({
    schema_version: z.literal(1),
    automatic_actions_enabled: z.boolean(),
    rules: z.array(moderationSettingsRule).max(100),
  })
  .superRefine((configuration, context) => {
    const references = new Set<string>();

    configuration.rules.forEach((rule, index) => {
      const reference = JSON.stringify([rule.rule_id, rule.rule_version]);
      if (references.has(reference)) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'rule_id'],
          message: 'Each rule and version can select only one action.',
        });
      }
      references.add(reference);
    });
  });

// Zero means no stored revision exists. Subsequent writes use the revision read.
export const moderationSettingsUpdate = z.strictObject({
  expected_revision: z.number().int().nonnegative().safe(),
  configuration: moderationSettingsConfiguration,
});

export const moderationSettingsRecord = z.strictObject({
  id: z.uuid(),
  channel_id: z.uuid(),
  revision: z.number().int().positive().safe(),
  configuration: moderationSettingsConfiguration,
  created_by: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
});

export const moderationSettingsResponse = z.strictObject({
  settings: moderationSettingsRecord.nullable(),
});

export type ModerationSettingsRule = z.infer<typeof moderationSettingsRule>;
export type ModerationSettingsConfiguration = z.infer<typeof moderationSettingsConfiguration>;
export type ModerationSettingsUpdate = z.infer<typeof moderationSettingsUpdate>;
export type ModerationSettingsRecord = z.infer<typeof moderationSettingsRecord>;
