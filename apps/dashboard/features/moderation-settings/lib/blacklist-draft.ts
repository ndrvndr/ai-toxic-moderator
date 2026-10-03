import type { CustomBlacklistConfiguration, CustomBlacklistRule } from '@moderator/contracts';

export type BlacklistEntryDraft = {
  id: string;
  enabled: boolean;
  match_type: CustomBlacklistRule['match_type'];
  pattern: string;
  action: CustomBlacklistRule['action'];
  duration_seconds: string;
};
export type BlacklistDraft = { enabled: boolean; rules: BlacklistEntryDraft[] };

export function toBlacklistDraft(configuration?: CustomBlacklistConfiguration): BlacklistDraft {
  return {
    enabled: configuration?.enabled ?? false,
    rules:
      configuration?.rules.map((rule) => ({
        ...rule,
        duration_seconds: rule.action === 'DELETE_TIMEOUT' ? String(rule.duration_seconds) : '300',
      })) ?? [],
  };
}

export function blacklistDraftInput(draft: BlacklistDraft) {
  return {
    schema_version: 1,
    enabled: draft.enabled,
    rules: draft.rules.map((entry) => ({
      id: entry.id,
      enabled: entry.enabled,
      match_type: entry.match_type,
      pattern: entry.pattern,
      action: entry.action,
      ...(entry.action === 'DELETE_TIMEOUT'
        ? {
            duration_seconds: entry.duration_seconds.trim()
              ? Number(entry.duration_seconds)
              : undefined,
          }
        : {}),
    })),
  };
}
