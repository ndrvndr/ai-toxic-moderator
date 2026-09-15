-- Allow observation provenance to reference a run within the same channel/session.
ALTER TABLE monitoring_runs
  ADD CONSTRAINT monitoring_runs_channel_session_id_key
  UNIQUE (channel_id, session_id, id);

CREATE TABLE youtube_chat_observations (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  first_observed_run_id uuid NOT NULL,

  external_message_id text NOT NULL
    CHECK (length(external_message_id) BETWEEN 1 AND 1024),
  event_type text NOT NULL
    CHECK (length(event_type) BETWEEN 1 AND 128),
  published_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- The adapter supplies a validated resource snapshot without credentials.
  payload jsonb NOT NULL
    CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash text NOT NULL
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),

  FOREIGN KEY (channel_id, session_id)
    REFERENCES youtube_broadcasts(channel_id, session_id),

  FOREIGN KEY (channel_id, session_id, first_observed_run_id)
    REFERENCES monitoring_runs(channel_id, session_id, id),

  UNIQUE (session_id, external_message_id, payload_hash),
  UNIQUE (channel_id, session_id, id)
);

CREATE INDEX youtube_chat_observations_history
  ON youtube_chat_observations(
    channel_id,
    session_id,
    received_at,
    id
  );

CREATE TRIGGER immutable_youtube_chat_observation
  BEFORE UPDATE ON youtube_chat_observations
  FOR EACH ROW
  EXECUTE FUNCTION reject_historical_update();