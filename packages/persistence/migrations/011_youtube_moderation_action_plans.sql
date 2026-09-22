ALTER TABLE youtube_chat_classifications
  ADD CONSTRAINT youtube_classification_scope_unique
  UNIQUE (channel_id, session_id, id);

CREATE TABLE youtube_moderation_action_plans (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  classification_id uuid NOT NULL,

  policy_version text NOT NULL
    CHECK (length(policy_version) BETWEEN 1 AND 128),

  action text NOT NULL
    CHECK (action IN ('NONE', 'DELETE', 'TIMEOUT', 'BAN')),

  duration_seconds bigint,

  reason text NOT NULL
    CHECK (length(reason) BETWEEN 1 AND 2000),

  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  FOREIGN KEY (channel_id, session_id, classification_id)
    REFERENCES youtube_chat_classifications(channel_id, session_id, id),

  UNIQUE (classification_id, policy_version),

  CHECK (
    (
      action = 'TIMEOUT'
      AND duration_seconds IS NOT NULL
      AND duration_seconds BETWEEN 1 AND 9007199254740991
    )
    OR
    (
      action IN ('NONE', 'DELETE', 'BAN')
      AND duration_seconds IS NULL
    )
  )
);

CREATE INDEX youtube_action_plan_session
  ON youtube_moderation_action_plans(
    channel_id,
    session_id,
    created_at DESC,
    id DESC
  );

CREATE TRIGGER immutable_youtube_action_plan
  BEFORE UPDATE ON youtube_moderation_action_plans
  FOR EACH ROW
  EXECUTE FUNCTION reject_historical_update();