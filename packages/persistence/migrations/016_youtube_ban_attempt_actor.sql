ALTER TABLE youtube_ban_attempts
  ADD COLUMN credential_account_id uuid REFERENCES accounts(id),
  ADD COLUMN moderator_channel_id text,
  ADD CONSTRAINT youtube_ban_attempt_actor_pair CHECK (
    (
      credential_account_id IS NULL
      AND moderator_channel_id IS NULL
    )
    OR (
      credential_account_id IS NOT NULL
      AND moderator_channel_id IS NOT NULL
      AND moderator_channel_id ~ '^UC[A-Za-z0-9_-]{22}$'
    )
  );

CREATE FUNCTION validate_youtube_ban_attempt_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.credential_account_id, NEW.moderator_channel_id)
      IS DISTINCT FROM
      ROW(OLD.credential_account_id, OLD.moderator_channel_id) THEN
      RAISE EXCEPTION 'Ban attempt actor identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.credential_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM youtube_ban_executions e
    JOIN youtube_moderation_action_plans p
      ON p.id = e.plan_id
      AND p.channel_id = e.channel_id
      AND p.session_id = e.session_id
    JOIN youtube_chat_classifications c
      ON c.id = p.classification_id
      AND c.channel_id = p.channel_id
      AND c.session_id = p.session_id
    JOIN monitoring_runs r
      ON r.id = c.run_id
      AND r.channel_id = c.channel_id
      AND r.session_id = c.session_id
    WHERE e.id = NEW.execution_id
      AND r.credential_account_id = NEW.credential_account_id
  ) THEN
    RAISE EXCEPTION 'Ban attempt credentials must match the original run'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_youtube_ban_attempt_actor
  BEFORE INSERT OR UPDATE ON youtube_ban_attempts
  FOR EACH ROW EXECUTE FUNCTION validate_youtube_ban_attempt_actor();

COMMENT ON COLUMN youtube_ban_attempts.moderator_channel_id IS
  'YouTube actor verified using the dispatch credential before the attempt.
   NULL means the actor was not recorded; do not infer it from the broadcast owner.';