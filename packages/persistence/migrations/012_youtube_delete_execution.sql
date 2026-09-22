-- Execution identity is stable across classification and action policy versions.
CREATE TABLE youtube_delete_executions (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES youtube_moderation_action_plans(id),
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  external_message_id text NOT NULL CHECK (length(external_message_id) BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (channel_id, session_id, external_message_id)
);

CREATE FUNCTION validate_youtube_delete_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM youtube_moderation_action_plans p
    JOIN youtube_chat_classifications c ON c.id = p.classification_id
      AND c.channel_id = p.channel_id AND c.session_id = p.session_id
    JOIN youtube_chat_observations o ON o.id = c.observation_id
      AND o.channel_id = c.channel_id AND o.session_id = c.session_id
    WHERE p.id = NEW.plan_id AND p.action = 'DELETE'
      AND p.channel_id = NEW.channel_id AND p.session_id = NEW.session_id
      AND o.external_message_id = NEW.external_message_id
  ) THEN
    RAISE EXCEPTION 'Deletion must target the message of a DELETE plan in the same scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_youtube_delete_execution
  BEFORE INSERT ON youtube_delete_executions
  FOR EACH ROW EXECUTE FUNCTION validate_youtube_delete_execution();

CREATE TRIGGER immutable_youtube_delete_execution
  BEFORE UPDATE ON youtube_delete_executions
  FOR EACH ROW EXECUTE FUNCTION reject_historical_update();

CREATE TABLE youtube_delete_attempts (
  id uuid PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES youtube_delete_executions(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  owner_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'DISPATCHED'
    CHECK (status IN ('DISPATCHED', 'SUCCEEDED', 'REJECTED', 'NOT_SENT', 'UNKNOWN')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  UNIQUE (execution_id, attempt_number),
  CHECK (deadline_at > started_at),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK (
    (status = 'DISPATCHED' AND finished_at IS NULL AND http_status IS NULL AND error_code IS NULL)
    OR
    (status = 'SUCCEEDED' AND finished_at IS NOT NULL AND http_status IS NOT NULL
      AND http_status = 204 AND error_code IS NULL)
    OR
    (status = 'REJECTED' AND finished_at IS NOT NULL AND http_status IS NOT NULL
      AND http_status IN (400, 401, 403, 404, 429) AND error_code IS NOT NULL)
    OR
    (status = 'NOT_SENT' AND finished_at IS NOT NULL AND http_status IS NULL AND error_code IS NOT NULL)
    OR
    (status = 'UNKNOWN' AND finished_at IS NOT NULL
      AND (http_status IS NULL OR http_status <> 204) AND error_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX youtube_delete_one_dispatched
  ON youtube_delete_attempts(execution_id) WHERE status = 'DISPATCHED';

CREATE INDEX youtube_delete_attempt_deadlines
  ON youtube_delete_attempts(deadline_at) WHERE status = 'DISPATCHED';

CREATE FUNCTION guard_youtube_delete_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_status text;
  previous_number integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Serialize attempts for one target, including attempts from different workers.
    PERFORM id FROM youtube_delete_executions WHERE id = NEW.execution_id FOR UPDATE;

    SELECT status, attempt_number INTO previous_status, previous_number
    FROM youtube_delete_attempts WHERE execution_id = NEW.execution_id
    ORDER BY attempt_number DESC LIMIT 1;

    IF NEW.status <> 'DISPATCHED'
      OR NEW.attempt_number <> COALESCE(previous_number, 0) + 1
      OR previous_status IN ('DISPATCHED', 'UNKNOWN', 'SUCCEEDED') THEN
      RAISE EXCEPTION 'The deletion attempt cannot be dispatched'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.status <> 'DISPATCHED' OR NEW.status = 'DISPATCHED'
      OR ROW(NEW.id, NEW.execution_id, NEW.attempt_number, NEW.owner_id, NEW.started_at, NEW.deadline_at)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.execution_id, OLD.attempt_number, OLD.owner_id, OLD.started_at, OLD.deadline_at) THEN
      RAISE EXCEPTION 'Only a dispatched attempt can receive an immutable final result'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_youtube_delete_attempt
  BEFORE INSERT OR UPDATE ON youtube_delete_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_youtube_delete_attempt();
