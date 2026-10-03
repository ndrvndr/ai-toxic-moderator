import {
  blacklistActionBundle,
  chatBlacklistDecision,
  customBlacklistSnapshot,
} from '@moderator/contracts';

export function summarizeChatBlacklist(
  bundleInput: unknown,
  snapshotInput: unknown,
  scope: {
    channelId: string;
    sessionId: string;
    classificationId: string | null;
    runId: string | null;
    reasonCode: string | null;
  },
) {
  if (bundleInput === null || bundleInput === undefined) return null;
  const bundle = blacklistActionBundle.parse(bundleInput);
  const snapshot = customBlacklistSnapshot.parse(snapshotInput);
  if (
    bundle.channel_id !== scope.channelId ||
    bundle.session_id !== scope.sessionId ||
    bundle.classification_id !== scope.classificationId ||
    bundle.run_id !== scope.runId ||
    snapshot.run_id !== bundle.run_id ||
    snapshot.channel_id !== bundle.channel_id ||
    snapshot.blacklist_id !== bundle.blacklist_id ||
    snapshot.blacklist_revision !== bundle.blacklist_revision ||
    snapshot.source !== bundle.source
  ) {
    throw new Error('Chat blacklist provenance scope mismatch.');
  }
  if (bundle.matched_rule_ids.length === 0) return null;
  const selected = snapshot.configuration.rules.find(
    (entry) => entry.id === bundle.selected_rule_id,
  );
  if (
    scope.reasonCode !== 'BLACKLIST_MATCH' ||
    !snapshot.configuration.enabled ||
    !selected ||
    selected.action !== bundle.selected_action ||
    (selected.action === 'DELETE_TIMEOUT' ? selected.duration_seconds : null) !==
      bundle.duration_seconds ||
    bundle.matched_rule_ids.some(
      (id) => !snapshot.configuration.rules.some((entry) => entry.id === id && entry.enabled),
    )
  ) {
    throw new Error('Invalid captured chat blacklist decision.');
  }
  return chatBlacklistDecision.parse({
    run_id: bundle.run_id,
    blacklist_id: bundle.blacklist_id,
    blacklist_revision: bundle.blacklist_revision,
    source: bundle.source,
    matcher_version: bundle.matcher_version,
    matched_rule_ids: bundle.matched_rule_ids,
    selected_entry: selected,
    author_action_status: bundle.author_action_status,
  });
}
