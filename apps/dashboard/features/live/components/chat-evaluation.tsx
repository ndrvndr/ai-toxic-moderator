import type { ChatEvaluation as Evaluation } from '@moderator/contracts';

const outcomeLabels: Record<Evaluation['outcome'], string> = {
  ALLOW: 'Allowed',
  REVIEW: 'Flagged',
  ACTION_REQUIRED: 'Action required',
  ERROR: 'Evaluation failed',
};

export function ChatEvaluation({ evaluation }: { evaluation: Evaluation | null }) {
  if (!evaluation) {
    return <p className="text-xs text-muted-foreground">Not evaluated</p>;
  }

  const flagged = evaluation.outcome === 'REVIEW' || evaluation.outcome === 'ACTION_REQUIRED';

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={
            flagged || evaluation.outcome === 'ERROR'
              ? 'font-medium text-destructive'
              : 'font-medium'
          }
        >
          {outcomeLabels[evaluation.outcome]}
        </span>

        {evaluation.primary_category && (
          <span className="rounded-md bg-muted px-2 py-1">
            {evaluation.primary_category.replaceAll('_', ' ')}
          </span>
        )}

        {evaluation.severity !== null && (
          <span className="text-muted-foreground">Severity: {evaluation.severity}/4</span>
        )}
      </div>

      <p className="whitespace-pre-wrap wrap-break-word text-xs text-muted-foreground">
        {evaluation.reason}
      </p>
    </div>
  );
}
