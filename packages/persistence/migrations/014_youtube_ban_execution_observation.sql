-- Prepare message-scoped execution identity before enabling repeated timeouts.
ALTER TABLE youtube_ban_executions
  ADD COLUMN observation_id uuid;

-- The migration runner executes this backfill and trigger restoration
-- in one transaction. Existing execution outcomes remain unchanged.
ALTER TABLE youtube_ban_executions
  DISABLE TRIGGER immutable_youtube_ban_execution;

UPDATE youtube_ban_executions e
SET observation_id = c.observation_id
FROM youtube_moderation_action_plans p
JOIN youtube_chat_classifications c
  ON c.id = p.classification_id
  AND c.channel_id = p.channel_id
  AND c.session_id = p.session_id
WHERE p.id = e.plan_id
  AND p.channel_id = e.channel_id
  AND p.session_id = e.session_id;

ALTER TABLE youtube_ban_executions
  ENABLE TRIGGER immutable_youtube_ban_execution;

ALTER TABLE youtube_ban_executions
  ALTER COLUMN observation_id SET NOT NULL,
  ADD CONSTRAINT youtube_ban_execution_observation_fk
    FOREIGN KEY (observation_id)
    REFERENCES youtube_chat_observations(id),
  ADD CONSTRAINT youtube_ban_execution_observation_key
    UNIQUE (channel_id, session_id, observation_id);

CREATE OR REPLACE FUNCTION validate_youtube_ban_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_observation_id uuid;
BEGIN
  SELECT o.id
  INTO expected_observation_id
  FROM youtube_moderation_action_plans p
  JOIN youtube_chat_classifications c
    ON c.id = p.classification_id
    AND c.channel_id = p.channel_id
    AND c.session_id = p.session_id
  JOIN youtube_chat_observations o
    ON o.id = c.observation_id
    AND o.channel_id = c.channel_id
    AND o.session_id = c.session_id
  JOIN youtube_broadcasts b
    ON b.channel_id = p.channel_id
    AND b.session_id = p.session_id
  WHERE p.id = NEW.plan_id
    AND p.action IN ('TIMEOUT', 'BAN')
    AND p.channel_id = NEW.channel_id
    AND p.session_id = NEW.session_id
    AND p.action = NEW.action
    AND p.duration_seconds IS NOT DISTINCT FROM NEW.duration_seconds
    AND b.live_chat_id = NEW.live_chat_id
    AND COALESCE(
      o.payload #>> '{authorDetails,channelId}',
      o.payload #>> '{snippet,authorChannelId}'
    ) = NEW.author_channel_id;

  IF expected_observation_id IS NULL THEN
    RAISE EXCEPTION 'Ban execution must match its plan, author, and live chat'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.observation_id IS NOT NULL
    AND NEW.observation_id <> expected_observation_id THEN
    RAISE EXCEPTION 'Ban execution must reference its original observation'
      USING ERRCODE = '23514';
  END IF;

  -- Derive provenance for callers that do not supply the new column yet.
  NEW.observation_id := expected_observation_id;

  RETURN NEW;
END;
$$;