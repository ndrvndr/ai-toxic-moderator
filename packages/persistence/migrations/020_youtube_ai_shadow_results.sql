-- Shadow results are independent of classifications and moderation action plans.
ALTER TABLE youtube_chat_observations
  ADD CONSTRAINT youtube_observation_first_run_key
  UNIQUE (channel_id, session_id, id, first_observed_run_id);

CREATE TABLE youtube_ai_shadow_results (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  model_id text NOT NULL
    CHECK (length(model_id) BETWEEN 1 AND 200
      AND model_id ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  model_revision text NOT NULL CHECK (model_revision ~ '^[a-f0-9]{40}$'),
  model_variant text NOT NULL CHECK (model_variant = 'INT8'),
  adapter_version text NOT NULL
    CHECK (length(adapter_version) BETWEEN 1 AND 128
      AND adapter_version ~ '^[A-Za-z0-9_.-]+$'),
  status text NOT NULL CHECK (status IN ('SUCCEEDED', 'ERROR')),
  rating smallint CHECK (rating IN (0, 2, 3, 4)),
  severity_score double precision CHECK (severity_score BETWEEN 0 AND 1),
  truncated boolean,
  inference_ms double precision CHECK (inference_ms BETWEEN 0 AND 3600000),
  error_code text CHECK (error_code IN (
    'MODEL_UNAVAILABLE', 'INFERENCE_FAILED', 'INFERENCE_TIMEOUT',
    'INVALID_OUTPUT', 'INPUT_TOO_LONG'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  FOREIGN KEY (channel_id, session_id, observation_id, run_id)
    REFERENCES youtube_chat_observations(channel_id, session_id, id, first_observed_run_id),
  FOREIGN KEY (channel_id, session_id, run_id)
    REFERENCES monitoring_runs(channel_id, session_id, id),
  UNIQUE (observation_id, model_id, model_revision, model_variant, adapter_version),

  CHECK (
    (status = 'SUCCEEDED'
      AND rating IS NOT NULL AND severity_score IS NOT NULL
      AND truncated IS NOT NULL AND inference_ms IS NOT NULL AND error_code IS NULL)
    OR
    (status = 'ERROR'
      AND rating IS NULL AND severity_score IS NULL
      AND truncated IS NULL AND inference_ms IS NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX youtube_ai_shadow_session
  ON youtube_ai_shadow_results(channel_id, session_id, created_at DESC, id DESC);

CREATE TRIGGER immutable_youtube_ai_shadow_result
  BEFORE UPDATE ON youtube_ai_shadow_results
  FOR EACH ROW EXECUTE FUNCTION reject_historical_update();
