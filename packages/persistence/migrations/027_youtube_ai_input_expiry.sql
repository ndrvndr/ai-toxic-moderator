-- Expired queue inputs retain an auditable result without a model score.
ALTER TABLE youtube_ai_shadow_results
  DROP CONSTRAINT youtube_ai_shadow_results_error_code_check;

ALTER TABLE youtube_ai_shadow_results
  ADD CONSTRAINT youtube_ai_shadow_results_error_code_check
  CHECK (error_code IN (
    'MODEL_UNAVAILABLE', 'INFERENCE_FAILED', 'INFERENCE_TIMEOUT',
    'INVALID_OUTPUT', 'INPUT_TOO_LONG', 'INPUT_EXPIRED'
  ));
