import { z } from 'zod';

import { aiShadowIdentity } from './ai-shadow';
import { moderationTimeoutDuration } from './moderation-settings';

// Thresholds apply only to this exact model and adapter identity.
export const aiModerationModelIdentity = aiShadowIdentity.pick({
  model_id: true,
  model_revision: true,
  model_variant: true,
  adapter_version: true,
});

// Expected severity is a model score, not a probability of a policy violation.
export const aiModerationThreshold = z.number().min(0).max(1);

const tier = {
  enabled: z.boolean(),
  threshold: aiModerationThreshold,
};

export const aiModerationSettingsConfiguration = z
  .strictObject({
    schema_version: z.literal(1),
    automatic_actions_enabled: z.boolean(),
    model: aiModerationModelIdentity,
    score_metric: z.literal('EXPECTED_SEVERITY'),
    delete: z.strictObject(tier),
    timeout: z.strictObject({ ...tier, duration_seconds: moderationTimeoutDuration }),
    ban: z.strictObject(tier),
  })
  .superRefine((configuration, context) => {
    // Staged tiers must remain ordered even while enforcement or a tier is disabled.
    if (configuration.delete.threshold >= configuration.timeout.threshold) {
      context.addIssue({
        code: 'custom',
        path: ['timeout', 'threshold'],
        message: 'Timeout threshold must be greater than delete threshold.',
      });
    }
    if (configuration.timeout.threshold >= configuration.ban.threshold) {
      context.addIssue({
        code: 'custom',
        path: ['ban', 'threshold'],
        message: 'Ban threshold must be greater than timeout threshold.',
      });
    }
  });

// Zero means no stored settings exist; later writes use the revision last read.
export const aiModerationSettingsUpdate = z.strictObject({
  expected_revision: z.number().int().nonnegative().safe(),
  configuration: aiModerationSettingsConfiguration,
});

export const aiModerationSettingsRecord = z.strictObject({
  id: z.uuid(),
  channel_id: z.uuid(),
  revision: z.number().int().positive().safe(),
  configuration: aiModerationSettingsConfiguration,
  created_by: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
});

export const aiModerationSettingsResponse = z.strictObject({
  settings: aiModerationSettingsRecord.nullable(),
});

// Missing and legacy settings carry no fabricated model or calibrated thresholds.
export const aiModerationSettingsSnapshot = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('SAVED'),
    run_id: z.uuid(),
    channel_id: z.uuid(),
    settings_id: z.uuid(),
    settings_revision: z.number().int().positive().safe(),
    configuration: aiModerationSettingsConfiguration,
  }),
  z.strictObject({
    source: z.enum(['DEFAULT', 'LEGACY']),
    run_id: z.uuid(),
    channel_id: z.uuid(),
    settings_id: z.null(),
    settings_revision: z.null(),
    configuration: z.null(),
  }),
]);

export type AiModerationModelIdentity = z.infer<typeof aiModerationModelIdentity>;
export type AiModerationSettingsConfiguration = z.infer<typeof aiModerationSettingsConfiguration>;
export type AiModerationSettingsUpdate = z.infer<typeof aiModerationSettingsUpdate>;
export type AiModerationSettingsRecord = z.infer<typeof aiModerationSettingsRecord>;
export type AiModerationSettingsResponse = z.infer<typeof aiModerationSettingsResponse>;
export type AiModerationSettingsSnapshot = z.infer<typeof aiModerationSettingsSnapshot>;
