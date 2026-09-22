CREATE TABLE live_event_counters (
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),

  PRIMARY KEY (channel_id, session_id),

  FOREIGN KEY (channel_id, session_id)
    REFERENCES youtube_broadcasts(channel_id, session_id)
);

CREATE TABLE live_events (
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  run_id uuid NOT NULL,
  event_type text NOT NULL
    CHECK (event_type IN ('chat.updated', 'monitoring.updated')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (channel_id, session_id, sequence),

  FOREIGN KEY (channel_id, session_id)
    REFERENCES live_event_counters(channel_id, session_id),

  FOREIGN KEY (channel_id, session_id, run_id)
    REFERENCES monitoring_runs(channel_id, session_id, id)
);

CREATE TRIGGER immutable_live_event
  BEFORE UPDATE ON live_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_historical_update();