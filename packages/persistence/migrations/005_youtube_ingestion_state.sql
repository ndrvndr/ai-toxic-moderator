-- One lease record per monitoring run.
-- The worker service must increment generation whenever ownership is acquired.
CREATE TABLE monitoring_worker_leases (
  run_id uuid PRIMARY KEY REFERENCES monitoring_runs(id),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  owner_id uuid,
  acquired_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz,

  CHECK (
    (
      owner_id IS NULL
      AND acquired_at IS NULL
      AND heartbeat_at IS NULL
      AND expires_at IS NULL
    )
    OR
    (
      owner_id IS NOT NULL
      AND generation > 0
      AND acquired_at IS NOT NULL
      AND heartbeat_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND heartbeat_at >= acquired_at
      AND expires_at > heartbeat_at
    )
  )
);

CREATE INDEX monitoring_worker_leases_expiry
  ON monitoring_worker_leases(expires_at)
  WHERE owner_id IS NOT NULL;

-- Checkpoints belong to the broadcast history session, not individual runs.
-- Advance the checkpoint in the same transaction that persists a received batch.
CREATE TABLE youtube_chat_checkpoints (
  session_id uuid PRIMARY KEY REFERENCES youtube_broadcasts(session_id),
  next_page_token text
    CHECK (next_page_token IS NULL OR length(next_page_token) > 0),
  next_poll_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_successful_poll_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  last_error_code text
    CHECK (
      last_error_code IS NULL
      OR length(last_error_code) BETWEEN 1 AND 128
    ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);