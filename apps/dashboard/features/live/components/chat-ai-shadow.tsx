import type { AiShadowErrorCode, AiShadowSummary } from '@moderator/contracts';

const ratingLabels: Record<NonNullable<AiShadowSummary['rating']>, string> = {
  0: 'Safe',
  2: 'Abusive',
  3: 'Hate',
  4: 'Severe',
};

const errorDescriptions: Record<AiShadowErrorCode, string> = {
  MODEL_UNAVAILABLE: 'The model was unavailable for this message.',
  INFERENCE_FAILED: 'Inference did not produce a usable result for this message.',
  INFERENCE_TIMEOUT: 'Inference exceeded its deadline for this message.',
  INVALID_OUTPUT: 'The model response failed validation.',
  INPUT_TOO_LONG: 'This message exceeded the inference input limit.',
};

export function ChatAiShadow({ result }: { result?: AiShadowSummary | null }) {
  if (!result) return null;

  return (
    <div role="group" aria-label="AI shadow result" className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">AI shadow</span>
        <span className="rounded-md bg-muted px-2 py-1">
          {result.status === 'SUCCEEDED' ? 'Model output' : 'AI result unavailable'}
        </span>
      </div>

      {result.status === 'SUCCEEDED' ? (
        <>
          <div className="flex flex-wrap gap-3 text-xs">
            <span>
              Model rating: {ratingLabels[result.rating]} ({result.rating}/4)
            </span>
            <span>Expected severity: {result.severity_score.toFixed(4)} / 1</span>
          </div>
          <p className="text-xs text-muted-foreground">
            This score measures model severity, not the probability of a policy violation.
          </p>
          {result.truncated && (
            <p className="text-xs text-muted-foreground">
              Input was truncated. The model did not evaluate the full message.
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {errorDescriptions[result.error_code]} No model rating is available.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Model output only. This is not an execution result. Automatic AI actions depend on the
        settings captured for this run and whether enforcement is enabled.
      </p>

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Model details</summary>
        <dl className="mt-2 space-y-2">
          <div>
            <dt className="font-medium">Model</dt>
            <dd className="wrap-break-word">{result.model_id}</dd>
          </div>
          <div>
            <dt className="font-medium">Revision</dt>
            <dd className="break-all">{result.model_revision}</dd>
          </div>
          <div>
            <dt className="font-medium">Variant</dt>
            <dd>{result.model_variant}</dd>
          </div>
          <div>
            <dt className="font-medium">Adapter</dt>
            <dd className="wrap-break-word">{result.adapter_version}</dd>
          </div>
          {result.status === 'SUCCEEDED' ? (
            <div>
              <dt className="font-medium">Inference time</dt>
              <dd>{result.inference_ms.toFixed(1)} ms</dd>
            </div>
          ) : (
            <div>
              <dt className="font-medium">Error code</dt>
              <dd>{result.error_code}</dd>
            </div>
          )}
        </dl>
        <p className="mt-2">
          Latest stored result for this message. Its revision may differ from the currently
          configured model.
        </p>
      </details>
    </div>
  );
}
