-- Extend stream sessions without changing previously applied migrations.
ALTER TABLE stream_sessions
  DROP CONSTRAINT stream_sessions_source_check;

ALTER TABLE stream_sessions
  ADD CONSTRAINT stream_sessions_source_check
  CHECK (source IN ('SYNTHETIC', 'YOUTUBE'));

ALTER TABLE stream_sessions
  ADD CONSTRAINT stream_sessions_channel_id_id_source_key
  UNIQUE (channel_id, id, source);

-- Maps an internal channel to its verified YouTube identity.
CREATE TABLE youtube_channels (
  channel_id uuid PRIMARY KEY REFERENCES channels(id),
  youtube_channel_id text NOT NULL UNIQUE
    CHECK (length(youtube_channel_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One history session per YouTube broadcast, even after monitoring restarts.
CREATE TABLE youtube_broadcasts (
  session_id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES youtube_channels(channel_id),
  source text NOT NULL DEFAULT 'YOUTUBE' CHECK (source = 'YOUTUBE'),
  youtube_broadcast_id text NOT NULL UNIQUE
    CHECK (length(youtube_broadcast_id) BETWEEN 1 AND 128),
  live_chat_id text NOT NULL
    CHECK (length(live_chat_id) BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  UNIQUE (channel_id, session_id),

  FOREIGN KEY (channel_id, session_id, source)
    REFERENCES stream_sessions(channel_id, id, source)
);

-- Each explicit monitoring start creates a run unless one is already active.
CREATE TABLE monitoring_runs (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  requested_by_account_id uuid NOT NULL REFERENCES accounts(id),
  credential_account_id uuid NOT NULL REFERENCES accounts(id),

  status text NOT NULL DEFAULT 'STARTING'
    CHECK (
      status IN (
        'STARTING',
        'RUNNING',
        'STOPPING',
        'STOPPED',
        'FAILED'
      )
    ),

  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  stop_requested_at timestamptz,
  stopped_by_account_id uuid REFERENCES accounts(id),
  finished_at timestamptz,
  last_error_code text,

  FOREIGN KEY (channel_id, session_id)
    REFERENCES youtube_broadcasts(channel_id, session_id),

  CHECK (started_at IS NULL OR started_at >= requested_at),
  CHECK (stop_requested_at IS NULL OR stop_requested_at >= requested_at),
  CHECK (finished_at IS NULL OR finished_at >= requested_at),
  CHECK (
    finished_at IS NULL
    OR started_at IS NULL
    OR finished_at >= started_at
  ),
  CHECK (
    finished_at IS NULL
    OR stop_requested_at IS NULL
    OR finished_at >= stop_requested_at
  ),
  CHECK (status <> 'RUNNING' OR started_at IS NOT NULL),
  CHECK (status <> 'STOPPING' OR stop_requested_at IS NOT NULL),
  CHECK (
    stopped_by_account_id IS NULL
    OR stop_requested_at IS NOT NULL
  ),
  CHECK (
    (
      status IN ('STOPPED', 'FAILED')
      AND finished_at IS NOT NULL
    )
    OR
    (
      status IN ('STARTING', 'RUNNING', 'STOPPING')
      AND finished_at IS NULL
    )
  )
);

-- Prevent concurrent monitoring runs for the same broadcast.
CREATE UNIQUE INDEX monitoring_runs_one_active_per_session
  ON monitoring_runs (session_id)
  WHERE status IN ('STARTING', 'RUNNING', 'STOPPING');

CREATE INDEX monitoring_runs_channel_history
  ON monitoring_runs (channel_id, requested_at DESC, id DESC);

CREATE INDEX monitoring_runs_session_history
  ON monitoring_runs (session_id, requested_at DESC, id DESC);

-- Preserve start-request identity even when multiple requests reuse one run.
CREATE TABLE monitoring_start_requests (
  account_id uuid NOT NULL REFERENCES accounts(id),
  request_key uuid NOT NULL,
  monitoring_run_id uuid NOT NULL REFERENCES monitoring_runs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (account_id, request_key)
);

CREATE INDEX monitoring_start_requests_run
  ON monitoring_start_requests (monitoring_run_id);