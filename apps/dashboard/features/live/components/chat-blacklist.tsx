import type { ChatBlacklistDecision } from '@moderator/contracts';

const matchLabels = { WORD: 'Word', PHRASE: 'Phrase', DOMAIN: 'Domain' };

export function ChatBlacklist({ decision }: { decision?: ChatBlacklistDecision | null }) {
  if (!decision) return null;
  const entry = decision.selected_entry;
  const action =
    entry.action === 'DELETE_TIMEOUT'
      ? `Delete message and timeout author for ${entry.duration_seconds} seconds`
      : entry.action === 'DELETE_BAN'
        ? 'Delete message and permanently ban author'
        : 'Delete message';

  return (
    <div
      role="group"
      aria-label="Blacklist decision"
      className="space-y-2 rounded-md border p-3 text-xs"
    >
      <p className="font-medium">Custom blacklist · Streamer policy</p>
      <p className="whitespace-pre-wrap wrap-break-word">
        {matchLabels[entry.match_type]}: <span className="font-medium">{entry.pattern}</span>
      </p>
      <p>Configured action: {action}</p>
      <p className="text-muted-foreground">
        This decision uses the blacklist captured when monitoring started. Provider results are
        shown separately.
      </p>
      {decision.author_action_status === 'TARGET_UNAVAILABLE' && (
        <p className="text-muted-foreground">
          No author action was planned because a valid author target was unavailable. The deletion
          plan is retained.
        </p>
      )}
      <details className="text-muted-foreground">
        <summary className="cursor-pointer">Blacklist details</summary>
        <dl className="mt-2 space-y-1 wrap-break-word">
          <dt>Captured revision</dt>
          <dd>{decision.blacklist_revision}</dd>
          <dt>Selected entry ID</dt>
          <dd>{entry.id}</dd>
          <dt>Matching entries</dt>
          <dd>{decision.matched_rule_ids.length}</dd>
          <dt>Matched entry IDs</dt>
          <dd>{decision.matched_rule_ids.join(', ')}</dd>
          <dt>Monitoring run</dt>
          <dd>{decision.run_id}</dd>
          <dt>Blacklist ID</dt>
          <dd>{decision.blacklist_id}</dd>
          <dt>Matcher version</dt>
          <dd>{decision.matcher_version}</dd>
        </dl>
      </details>
    </div>
  );
}
