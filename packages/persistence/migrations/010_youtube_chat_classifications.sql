CREATE TABLE youtube_chat_classifications (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  run_id uuid NOT NULL,

  classifier_version text NOT NULL
    CHECK (length(classifier_version) BETWEEN 1 AND 128),
  policy_version text NOT NULL
    CHECK (length(policy_version) BETWEEN 1 AND 128),

  outcome text NOT NULL
    CHECK (outcome IN ('ALLOW', 'REVIEW', 'ACTION_REQUIRED', 'ERROR')),
  primary_category text
    CHECK (
      primary_category IN (
        'PROFANITY',
        'HARASSMENT',
        'HATE',
        'THREAT',
        'SEXUAL',
        'GAMBLING',
        'SPAM',
        'SCAM',
        'PII',
        'SELF_HARM_ENCOURAGEMENT',
        'IMPERSONATION',
        'SUSPICIOUS_LINK'
      )
    ),
  severity smallint CHECK (severity BETWEEN 0 AND 4),
  reason_code text NOT NULL
    CHECK (
      reason_code IN (
        'NO_RULE_MATCH',
        'CONTEXT_REQUIRED',
        'GAMBLING_PROMOTION',
        'DIRECT_INSULT',
        'PROCESSING_FAILED'
      )
    ),
  reason text NOT NULL
    CHECK (length(reason) BETWEEN 1 AND 2000),
  signals jsonb NOT NULL
    CHECK (jsonb_typeof(signals) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  FOREIGN KEY (channel_id, session_id, observation_id)
    REFERENCES youtube_chat_observations(channel_id, session_id, id),

  FOREIGN KEY (channel_id, session_id, run_id)
    REFERENCES monitoring_runs(channel_id, session_id, id),

  UNIQUE (observation_id, classifier_version, policy_version),

  CHECK (
    (
      outcome = 'ALLOW'
      AND primary_category IS NULL
      AND severity = 0
      AND reason_code = 'NO_RULE_MATCH'
    )
    OR
    (
      outcome IN ('REVIEW', 'ACTION_REQUIRED')
      AND primary_category IS NOT NULL
      AND severity BETWEEN 1 AND 4
    )
    OR
    (
      outcome = 'ERROR'
      AND primary_category IS NULL
      AND severity IS NULL
      AND reason_code = 'PROCESSING_FAILED'
    )
  )
);

CREATE INDEX youtube_classification_session
  ON youtube_chat_classifications(session_id, created_at DESC, id DESC);

CREATE INDEX youtube_classification_outcome
  ON youtube_chat_classifications(
    channel_id,
    session_id,
    outcome,
    created_at DESC,
    id DESC
  );

CREATE TRIGGER immutable_youtube_classification
  BEFORE UPDATE ON youtube_chat_classifications
  FOR EACH ROW
  EXECUTE FUNCTION reject_historical_update();