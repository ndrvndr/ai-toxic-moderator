import type { HistoryStatistics } from '@moderator/contracts';

type FlaggedReasons = HistoryStatistics['flagged_reasons'];

const reasonLabels: Record<FlaggedReasons[number]['reason_code'], string> = {
  NO_RULE_MATCH: 'No rule matched',
  CONTEXT_REQUIRED: 'Context required',
  GAMBLING_PROMOTION: 'Gambling promotion',
  DIRECT_INSULT: 'Direct insult',
  PROCESSING_FAILED: 'Processing failed',
};

export function HistoryFlaggedReasons({ reasons }: { reasons: FlaggedReasons }) {
  return (
    <section aria-label="Flagged message reasons" className="space-y-3">
      <h3 className="font-semibold">Flagged message reasons</h3>

      <p className="text-sm text-muted-foreground">
        Grouped by primary category and reason from the latest evaluation. Detailed explanations are
        available on individual chat messages.
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
                <p className="text-sm font-medium">{reason.category.replaceAll('_', ' ')}</p>
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
