import type { HistoryStatistics } from '@moderator/contracts';

type FlaggedReasons = HistoryStatistics['flagged_reasons'];

const reasonLabels: Record<FlaggedReasons[number]['reason_code'], string> = {
  NO_RULE_MATCH: 'No rule matched',
  CONTEXT_REQUIRED: 'Context required',
  GAMBLING_PROMOTION: 'Gambling promotion',
  DIRECT_INSULT: 'Direct insult',
  PROCESSING_FAILED: 'Processing failed',
  BLACKLIST_MATCH: 'Custom blacklist match',
};

export function HistoryFlaggedReasons({ reasons }: { reasons: FlaggedReasons }) {
  return (
    <section aria-label="Flagged message reasons" className="space-y-3">
      <h3 className="font-semibold">Flagged message reasons</h3>

      <p className="text-sm text-muted-foreground">
        The reasons your rule checks flagged messages. Open a message’s moderation details for its
        full explanation.
      </p>

      {reasons.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No flagged messages in this session.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {reasons.map((reason) => (
            <li
              key={`${reason.category}:${reason.reason_code}`}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {reason.category?.replaceAll('_', ' ') ?? 'Streamer policy'}
                </p>
                <p className="text-sm text-muted-foreground">{reasonLabels[reason.reason_code]}</p>
              </div>

              <span className="shrink-0 text-sm tabular-nums">
                {reason.message_count.toLocaleString('en-US')}{' '}
                {reason.message_count === 1 ? 'message' : 'messages'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
