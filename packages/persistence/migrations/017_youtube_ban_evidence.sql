CREATE TABLE youtube_ban_evidence (
  attempt_id uuid NOT NULL REFERENCES youtube_ban_attempts(id),
  observation_id uuid NOT NULL REFERENCES youtube_chat_observations(id),
  attribution text NOT NULL DEFAULT 'UNPROVEN'
    CHECK (attribution = 'UNPROVEN'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (attempt_id, observation_id)
);

CREATE FUNCTION validate_youtube_ban_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM youtube_ban_attempts a
    JOIN youtube_ban_executions e
      ON e.id = a.execution_id
    JOIN youtube_chat_observations o
      ON o.id = NEW.observation_id
      AND o.channel_id = e.channel_id
      AND o.session_id = e.session_id
    WHERE a.id = NEW.attempt_id
      AND a.status = 'UNKNOWN'
      AND a.credential_account_id IS NOT NULL
      AND a.moderator_channel_id IS NOT NULL
      AND o.event_type = 'userBannedEvent'
      AND o.published_at BETWEEN a.started_at AND a.deadline_at
      AND o.payload ->> 'id' = o.external_message_id
      AND o.payload #>> '{snippet,type}' = 'userBannedEvent'
      AND o.payload #>> '{snippet,liveChatId}' = e.live_chat_id
      AND o.payload #>> '{snippet,authorChannelId}' = a.moderator_channel_id
      AND o.payload #>> '{snippet,userBannedDetails,bannedUserDetails,channelId}'
        = e.author_channel_id
      AND (
        (
          e.action = 'TIMEOUT'
          AND o.payload #>> '{snippet,userBannedDetails,banType}' = 'temporary'
          AND o.payload #>> '{snippet,userBannedDetails,banDurationSeconds}'
            = e.duration_seconds::text
        )
        OR (
          e.action = 'BAN'
          AND o.payload #>> '{snippet,userBannedDetails,banType}' = 'permanent'
          AND NOT (
            (o.payload #> '{snippet,userBannedDetails}')
              ? 'banDurationSeconds'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Evidence must match an unknown attempt and its scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_youtube_ban_evidence
  BEFORE INSERT ON youtube_ban_evidence
  FOR EACH ROW
  EXECUTE FUNCTION validate_youtube_ban_evidence();

CREATE TRIGGER immutable_youtube_ban_evidence
  BEFORE UPDATE ON youtube_ban_evidence
  FOR EACH ROW
  EXECUTE FUNCTION reject_historical_update();

COMMENT ON TABLE youtube_ban_evidence IS
  'Candidate event evidence only. Matching does not prove request attribution
   and must not authorize automatic redispatch.';