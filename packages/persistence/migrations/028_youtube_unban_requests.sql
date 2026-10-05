-- Removal evidence never rewrites the historical ban attempt.
CREATE TABLE youtube_unban_requests (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  ban_attempt_id uuid NOT NULL REFERENCES youtube_ban_attempts(id),
  execution_id uuid NOT NULL REFERENCES youtube_ban_executions(id),
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  requested_by_account_id uuid NOT NULL REFERENCES accounts(id),
  credential_account_id uuid REFERENCES accounts(id),
  method text NOT NULL CHECK (method IN ('YOUTUBE', 'STUDIO_CONFIRMATION')),
  status text NOT NULL CHECK (status IN (
    'DISPATCHED', 'SUCCEEDED', 'REJECTED', 'NOT_SENT', 'UNKNOWN', 'USER_CONFIRMED'
  )),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz,
  finished_at timestamptz,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  UNIQUE (requested_by_account_id, request_id),
  FOREIGN KEY (channel_id, session_id)
    REFERENCES youtube_broadcasts(channel_id, session_id),
  CHECK (finished_at IS NULL OR finished_at >= requested_at),
  CHECK (
    (method = 'STUDIO_CONFIRMATION' AND status = 'USER_CONFIRMED'
      AND credential_account_id IS NULL AND deadline_at IS NULL
      AND finished_at IS NOT NULL AND http_status IS NULL AND error_code IS NULL)
    OR (method = 'YOUTUBE' AND credential_account_id IS NOT NULL
      AND deadline_at IS NOT NULL AND deadline_at > requested_at
      AND deadline_at <= requested_at + interval '300 seconds'
      AND (
        (status = 'DISPATCHED' AND finished_at IS NULL
          AND http_status IS NULL AND error_code IS NULL)
        OR (status = 'SUCCEEDED' AND finished_at IS NOT NULL
          AND http_status IS NOT NULL AND http_status = 204 AND error_code IS NULL)
        OR (status = 'REJECTED' AND finished_at IS NOT NULL
          AND http_status IS NOT NULL AND http_status IN (400, 401, 403, 404, 429)
          AND error_code IS NOT NULL)
        OR (status = 'NOT_SENT' AND finished_at IS NOT NULL
          AND http_status IS NULL AND error_code IS NOT NULL)
        OR (status = 'UNKNOWN' AND finished_at IS NOT NULL AND error_code IS NOT NULL)
      ))
  )
);

-- Failed/unknown requests remain audit history. Studio confirmation may resolve
-- uncertainty explicitly, but concurrent/removal-confirmed requests cannot duplicate.
CREATE UNIQUE INDEX youtube_unban_one_active_removal
  ON youtube_unban_requests(ban_attempt_id)
  WHERE status IN ('DISPATCHED', 'SUCCEEDED', 'USER_CONFIRMED');
CREATE INDEX youtube_unban_deadlines ON youtube_unban_requests(deadline_at, id)
  WHERE status = 'DISPATCHED';
CREATE INDEX youtube_unban_scope_history
  ON youtube_unban_requests(channel_id, session_id, execution_id, requested_at, id);

CREATE FUNCTION guard_youtube_unban_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT (
      (NEW.method = 'YOUTUBE' AND NEW.status = 'DISPATCHED')
      OR (NEW.method = 'STUDIO_CONFIRMATION' AND NEW.status = 'USER_CONFIRMED')
    ) THEN
      RAISE EXCEPTION 'Removal requests must begin dispatched or user-confirmed'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM youtube_ban_attempts a
      JOIN youtube_ban_executions e ON e.id = a.execution_id
      JOIN youtube_moderation_action_plans p ON p.id = e.plan_id
        AND p.channel_id = e.channel_id AND p.session_id = e.session_id
      JOIN youtube_chat_classifications c ON c.id = p.classification_id
        AND c.channel_id = p.channel_id AND c.session_id = p.session_id
      JOIN monitoring_runs r ON r.id = c.run_id
        AND r.channel_id = c.channel_id AND r.session_id = c.session_id
      WHERE a.id = NEW.ban_attempt_id AND e.id = NEW.execution_id
        AND e.channel_id = NEW.channel_id AND e.session_id = NEW.session_id
        AND e.action = 'BAN' AND a.status = 'SUCCEEDED' AND a.ban_id IS NOT NULL
        AND NEW.requested_at >= a.finished_at
        AND (NEW.method = 'STUDIO_CONFIRMATION'
          OR NEW.credential_account_id = r.credential_account_id)
    ) THEN
      RAISE EXCEPTION 'Removal must match a confirmed permanent ban and its scope'
        USING ERRCODE = '23514';
    END IF;

    -- The API also rechecks authorization before dispatch. Preserve the role
    -- requirement here without blocking result recording after access revocation.
    PERFORM 1 FROM channel_memberships
      WHERE channel_id = NEW.channel_id
        AND account_id = NEW.requested_by_account_id AND role = 'OWNER'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Removal requires the channel owner'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.status <> 'DISPATCHED' OR NEW.status = 'DISPATCHED'
      OR ROW(NEW.id, NEW.request_id, NEW.ban_attempt_id, NEW.execution_id,
        NEW.channel_id, NEW.session_id, NEW.requested_by_account_id,
        NEW.credential_account_id, NEW.method, NEW.requested_at, NEW.deadline_at)
        IS DISTINCT FROM
        ROW(OLD.id, OLD.request_id, OLD.ban_attempt_id, OLD.execution_id,
        OLD.channel_id, OLD.session_id, OLD.requested_by_account_id,
        OLD.credential_account_id, OLD.method, OLD.requested_at, OLD.deadline_at)
    THEN
      RAISE EXCEPTION 'Only a dispatched removal can receive an immutable result'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_youtube_unban_request
  BEFORE INSERT OR UPDATE ON youtube_unban_requests
  FOR EACH ROW EXECUTE FUNCTION guard_youtube_unban_request();

COMMENT ON TABLE youtube_unban_requests IS
  'Manual removal audit. USER_CONFIRMED is a streamer statement, not provider
   confirmation. Historical ban outcomes remain unchanged.';
