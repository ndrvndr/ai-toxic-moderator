-- One current automatic-AI report per channel; this is not an action audit.
CREATE TABLE ai_operational_status (
  channel_id uuid PRIMARY KEY REFERENCES channels(id),
  session_id uuid,
  run_id uuid,
  status text NOT NULL,
  reason text NOT NULL,
  error_code text,
  owner_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  updated_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,

  FOREIGN KEY (channel_id, session_id, run_id)
    REFERENCES monitoring_runs(channel_id, session_id, id),
  CHECK ((session_id IS NULL) = (run_id IS NULL)),
  CHECK (
    (status = 'DISABLED' AND error_code IS NULL AND (
      (reason = 'WORKER_AI_DISABLED' AND run_id IS NULL) OR
      (reason = 'RUN_AI_DISABLED' AND run_id IS NOT NULL)
    )) OR
    (status = 'WAITING' AND reason = 'NO_ELIGIBLE_RUN'
      AND error_code IS NULL AND run_id IS NULL) OR
    (status = 'ACTIVE' AND reason = 'RUN_SELECTED'
      AND error_code IS NULL AND run_id IS NOT NULL) OR
    (status = 'MODEL_MISMATCH' AND reason = 'CAPTURED_MODEL_MISMATCH'
      AND error_code IS NULL AND run_id IS NOT NULL) OR
    (status = 'CAPACITY_EXCEEDED' AND reason = 'MULTIPLE_ELIGIBLE_RUNS'
      AND error_code IS NULL AND run_id IS NULL) OR
    (status = 'ERROR' AND reason = 'PROCESSING_FAILED' AND error_code IS NOT NULL
      AND error_code IN ('MODEL_UNAVAILABLE','INFERENCE_FAILED','INFERENCE_TIMEOUT',
        'INVALID_OUTPUT','DATABASE_UNAVAILABLE','PIPELINE_FAILED'))
  ),
  CHECK (heartbeat_at >= updated_at),
  CHECK (expires_at = heartbeat_at + interval '30 seconds')
);

-- Clock timestamps are assigned after the row lock, never supplied by a client.
-- A generation fences expired owners, including a reused owner UUID.
CREATE FUNCTION stamp_ai_operational_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  moment timestamptz := clock_timestamp();
  changed boolean := true;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.generation := 1;
  ELSE
    IF NEW.channel_id IS DISTINCT FROM OLD.channel_id THEN
      RAISE EXCEPTION 'AI status channel is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.generation <> OLD.generation THEN
      IF OLD.expires_at > moment OR NEW.generation <> OLD.generation + 1 THEN
        RAISE EXCEPTION 'AI status lease cannot be replaced' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.expires_at <= moment THEN
      RAISE EXCEPTION 'AI status lease expired' USING ERRCODE = '23514';
    END IF;
    moment := GREATEST(moment, OLD.heartbeat_at);
    changed := ROW(NEW.session_id, NEW.run_id, NEW.status, NEW.reason, NEW.error_code,
      NEW.owner_id, NEW.generation) IS DISTINCT FROM
      ROW(OLD.session_id, OLD.run_id, OLD.status, OLD.reason, OLD.error_code,
      OLD.owner_id, OLD.generation);
  END IF;
  NEW.updated_at := CASE WHEN changed THEN moment ELSE OLD.updated_at END;
  NEW.heartbeat_at := moment;
  NEW.expires_at := moment + interval '30 seconds';
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_operational_status_stamp
BEFORE INSERT OR UPDATE ON ai_operational_status
FOR EACH ROW EXECUTE FUNCTION stamp_ai_operational_status();
