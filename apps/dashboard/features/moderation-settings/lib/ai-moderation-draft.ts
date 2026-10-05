import type { AiModerationSettingsConfiguration } from '@moderator/contracts';

export type AiTierDraft = { enabled: boolean; threshold: string };
export type AiModerationDraft = {
  automatic_actions_enabled: boolean;
  delete: AiTierDraft;
  timeout: AiTierDraft & { duration_seconds: string };
  ban: AiTierDraft;
};

export function toAiModerationDraft(
  configuration?: AiModerationSettingsConfiguration,
): AiModerationDraft {
  return {
    automatic_actions_enabled: configuration?.automatic_actions_enabled ?? true,
    delete: {
      enabled: configuration?.delete.enabled ?? true,
      threshold: configuration ? String(configuration.delete.threshold) : '',
    },
    timeout: {
      enabled: configuration?.timeout.enabled ?? true,
      threshold: configuration ? String(configuration.timeout.threshold) : '',
      duration_seconds: configuration ? String(configuration.timeout.duration_seconds) : '30',
    },
    ban: {
      enabled: configuration?.ban.enabled ?? true,
      threshold: configuration ? String(configuration.ban.threshold) : '',
    },
  };
}

// Empty controls must not become zero through Number(''). Shared contracts validate bounds.
const numericInput = (value: string) => (value.trim() ? Number(value) : undefined);

export function aiModerationDraftInput(draft: AiModerationDraft) {
  return {
    schema_version: 1,
    automatic_actions_enabled: draft.automatic_actions_enabled,
    score_metric: 'EXPECTED_SEVERITY',
    delete: { enabled: draft.delete.enabled, threshold: numericInput(draft.delete.threshold) },
    timeout: {
      enabled: draft.timeout.enabled,
      threshold: numericInput(draft.timeout.threshold),
      duration_seconds: numericInput(draft.timeout.duration_seconds),
    },
    ban: { enabled: draft.ban.enabled, threshold: numericInput(draft.ban.threshold) },
  };
}
