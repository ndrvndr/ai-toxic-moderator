-- Conservative first lifecycle: one author-targeted action per broadcast session.
CREATE TABLE youtube_ban_executions (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES youtube_moderation_action_plans(id),
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  live_chat_id text NOT NULL CHECK (length(live_chat_id) BETWEEN 1 AND 1024),
  author_channel_id text NOT NULL CHECK (length(author_channel_id) BETWEEN 1 AND 1024),
  action text NOT NULL CHECK (action IN ('TIMEOUT', 'BAN')),
  duration_seconds bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (channel_id, session_id, author_channel_id),
  FOREIGN KEY (channel_id, session_id) REFERENCES youtube_broadcasts(channel_id, session_id),
  CHECK ((action = 'TIMEOUT' AND duration_seconds IS NOT NULL AND duration_seconds BETWEEN 1 AND 9007199254740991)
    OR (action = 'BAN' AND duration_seconds IS NULL))
);

CREATE FUNCTION validate_youtube_ban_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM youtube_moderation_action_plans p
    JOIN youtube_chat_classifications c ON c.id = p.classification_id
      AND c.channel_id = p.channel_id AND c.session_id = p.session_id
    JOIN youtube_chat_observations o ON o.id = c.observation_id
      AND o.channel_id = c.channel_id AND o.session_id = c.session_id
    JOIN youtube_broadcasts b ON b.channel_id = p.channel_id AND b.session_id = p.session_id
    WHERE p.id = NEW.plan_id AND p.action IN ('TIMEOUT', 'BAN')
      AND p.channel_id = NEW.channel_id AND p.session_id = NEW.session_id
      AND p.action = NEW.action AND p.duration_seconds IS NOT DISTINCT FROM NEW.duration_seconds
      AND b.live_chat_id = NEW.live_chat_id
      AND COALESCE(o.payload #>> '{authorDetails,channelId}', o.payload #>> '{snippet,authorChannelId}') = NEW.author_channel_id
  ) THEN
    RAISE EXCEPTION 'Ban execution must match its plan, author, and live chat'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_youtube_ban_execution
  BEFORE INSERT ON youtube_ban_executions
  FOR EACH ROW EXECUTE FUNCTION validate_youtube_ban_execution();
CREATE TRIGGER immutable_youtube_ban_execution
  BEFORE UPDATE ON youtube_ban_executions
  FOR EACH ROW EXECUTE FUNCTION reject_historical_update();

CREATE TABLE youtube_ban_attempts (
  id uuid PRIMARY KEY,
  execution_id uuid NOT NULL UNIQUE REFERENCES youtube_ban_executions(id),
  owner_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'DISPATCHED'
    CHECK (status IN ('DISPATCHED', 'SUCCEEDED', 'REJECTED', 'NOT_SENT', 'UNKNOWN')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  ban_id text CHECK (length(ban_id) BETWEEN 1 AND 1024),
  CHECK (deadline_at > started_at),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK (
    (status = 'DISPATCHED' AND finished_at IS NULL AND http_status IS NULL AND error_code IS NULL AND ban_id IS NULL)
    OR (status = 'SUCCEEDED' AND finished_at IS NOT NULL AND http_status IS NOT NULL
      AND http_status IN (200, 201) AND ban_id IS NOT NULL AND error_code IS NULL)
    OR (status = 'REJECTED' AND finished_at IS NOT NULL AND http_status IS NOT NULL
      AND http_status IN (400, 401, 403, 404, 429) AND error_code IS NOT NULL AND ban_id IS NULL)
    OR (status = 'NOT_SENT' AND finished_at IS NOT NULL AND http_status IS NULL AND error_code IS NOT NULL AND ban_id IS NULL)
    OR (status = 'UNKNOWN' AND finished_at IS NOT NULL AND error_code IS NOT NULL AND ban_id IS NULL)
  )
);

CREATE INDEX youtube_ban_attempt_deadlines ON youtube_ban_attempts(deadline_at)
  WHERE status = 'DISPATCHED';

CREATE FUNCTION guard_youtube_ban_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DISPATCHED' THEN
      RAISE EXCEPTION 'Ban attempts must begin dispatched' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.status <> 'DISPATCHED' OR NEW.status = 'DISPATCHED'
      OR ROW(NEW.id, NEW.execution_id, NEW.owner_id, NEW.started_at, NEW.deadline_at)
         IS DISTINCT FROM ROW(OLD.id, OLD.execution_id, OLD.owner_id, OLD.started_at, OLD.deadline_at) THEN
      RAISE EXCEPTION 'Only a dispatched ban attempt can receive an immutable result'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_youtube_ban_attempt
  BEFORE INSERT OR UPDATE ON youtube_ban_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_youtube_ban_attempt();
