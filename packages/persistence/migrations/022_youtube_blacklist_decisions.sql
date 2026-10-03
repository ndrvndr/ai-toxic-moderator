-- Independent message/author plans retain the existing executor format.
ALTER TABLE youtube_moderation_action_plans
  ADD CONSTRAINT youtube_action_plan_classification_scope_unique
  UNIQUE (channel_id, session_id, classification_id, id);

CREATE TABLE youtube_blacklist_decisions (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  classification_id uuid NOT NULL,
  run_id uuid NOT NULL,
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 110),
  bundle jsonb NOT NULL,
  message_plan_id uuid UNIQUE,
  author_plan_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (classification_id, policy_version),
  FOREIGN KEY (channel_id, session_id, classification_id)
    REFERENCES youtube_chat_classifications(channel_id, session_id, id),
  FOREIGN KEY (channel_id, session_id, run_id)
    REFERENCES monitoring_runs(channel_id, session_id, id),
  FOREIGN KEY (channel_id, session_id, classification_id, message_plan_id)
    REFERENCES youtube_moderation_action_plans(channel_id, session_id, classification_id, id),
  FOREIGN KEY (channel_id, session_id, classification_id, author_plan_id)
    REFERENCES youtube_moderation_action_plans(channel_id, session_id, classification_id, id),
  CHECK (message_plan_id IS NULL OR author_plan_id IS NULL OR message_plan_id <> author_plan_id),
  CHECK (
    CASE WHEN jsonb_typeof(bundle) = 'object' THEN
      (bundle -> 'schema_version' = '1'::jsonb
       AND jsonb_typeof(bundle -> 'plans') = 'array'
       AND jsonb_typeof(bundle -> 'matched_rule_ids') = 'array') IS TRUE
    ELSE false END
  )
);

CREATE FUNCTION validate_youtube_blacklist_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  classification_run uuid;
  observed_message text;
  observed_author text;
  captured monitoring_blacklist_snapshots%ROWTYPE;
  plan youtube_moderation_action_plans%ROWTYPE;
  expected jsonb;
  matched_count integer;
  plan_count integer;
BEGIN
  SELECT c.run_id, o.external_message_id,
    COALESCE(o.payload #>> '{authorDetails,channelId}', o.payload #>> '{snippet,authorChannelId}')
  INTO classification_run, observed_message, observed_author
  FROM youtube_chat_classifications c
  JOIN youtube_chat_observations o ON o.id = c.observation_id
    AND o.channel_id = c.channel_id AND o.session_id = c.session_id
  WHERE c.id = NEW.classification_id AND c.channel_id = NEW.channel_id AND c.session_id = NEW.session_id;
  IF classification_run IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'Blacklist decision must use the original classification run' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO captured FROM monitoring_blacklist_snapshots
  WHERE run_id = NEW.run_id AND channel_id = NEW.channel_id;
  IF NOT FOUND OR
    NEW.bundle ->> 'run_id' IS DISTINCT FROM NEW.run_id::text OR
    NEW.bundle ->> 'channel_id' IS DISTINCT FROM NEW.channel_id::text OR
    NEW.bundle ->> 'session_id' IS DISTINCT FROM NEW.session_id::text OR
    NEW.bundle ->> 'classification_id' IS DISTINCT FROM NEW.classification_id::text OR
    NEW.bundle ->> 'policy_version' IS DISTINCT FROM NEW.policy_version OR
    NEW.bundle ->> 'source' IS DISTINCT FROM captured.source OR
    NEW.bundle -> 'blacklist_id' IS DISTINCT FROM COALESCE(to_jsonb(captured.blacklist_id), 'null'::jsonb) OR
    NEW.bundle -> 'blacklist_revision' IS DISTINCT FROM COALESCE(to_jsonb(captured.blacklist_revision), 'null'::jsonb)
  THEN
    RAISE EXCEPTION 'Blacklist decision metadata must match its captured scope and revision' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW.bundle -> 'plans') IS DISTINCT FROM 'array' OR
     jsonb_typeof(NEW.bundle -> 'matched_rule_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Blacklist decision requires plan and match arrays' USING ERRCODE = '23514';
  END IF;
  matched_count := jsonb_array_length(NEW.bundle -> 'matched_rule_ids');
  plan_count := jsonb_array_length(NEW.bundle -> 'plans');
  IF matched_count = 0 THEN
    IF plan_count <> 0 OR NEW.message_plan_id IS NOT NULL OR NEW.author_plan_id IS NOT NULL THEN
      RAISE EXCEPTION 'Unmatched blacklist decisions cannot reference plans' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF matched_count > 100 OR NEW.message_plan_id IS NULL OR plan_count NOT IN (1, 2) OR
       (plan_count = 2) <> (NEW.author_plan_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Matched blacklist decisions require complete independent plan slots' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO plan FROM youtube_moderation_action_plans WHERE id = NEW.message_plan_id
      AND channel_id = NEW.channel_id AND session_id = NEW.session_id AND classification_id = NEW.classification_id;
    IF NOT FOUND OR plan.action <> 'DELETE' OR plan.policy_version <> NEW.policy_version || ':message' THEN
      RAISE EXCEPTION 'Message slot must reference its scoped deletion plan' USING ERRCODE = '23514';
    END IF;
    expected := jsonb_build_object('classification_id', plan.classification_id, 'channel_id', plan.channel_id,
      'session_id', plan.session_id, 'policy_version', plan.policy_version, 'reason', plan.reason,
      'action', 'DELETE', 'external_message_id', observed_message);
    IF NEW.bundle -> 'plans' -> 0 IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'Message plan must match its persisted fields and observed target' USING ERRCODE = '23514';
    END IF;
    IF NEW.author_plan_id IS NOT NULL THEN
      SELECT * INTO plan FROM youtube_moderation_action_plans WHERE id = NEW.author_plan_id
        AND channel_id = NEW.channel_id AND session_id = NEW.session_id AND classification_id = NEW.classification_id;
      IF NOT FOUND OR plan.action NOT IN ('TIMEOUT', 'BAN') OR plan.policy_version <> NEW.policy_version || ':author' THEN
        RAISE EXCEPTION 'Author slot must reference its scoped author plan' USING ERRCODE = '23514';
      END IF;
      expected := jsonb_build_object('classification_id', plan.classification_id, 'channel_id', plan.channel_id,
        'session_id', plan.session_id, 'policy_version', plan.policy_version, 'reason', plan.reason,
        'action', plan.action, 'author_channel_id', observed_author);
      IF plan.action = 'TIMEOUT' THEN expected := expected || jsonb_build_object('duration_seconds', plan.duration_seconds); END IF;
      IF NEW.bundle -> 'plans' -> 1 IS DISTINCT FROM expected THEN
        RAISE EXCEPTION 'Author plan must match its persisted fields and observed target' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_youtube_blacklist_decision
  BEFORE INSERT ON youtube_blacklist_decisions
  FOR EACH ROW EXECUTE FUNCTION validate_youtube_blacklist_decision();
CREATE TRIGGER immutable_youtube_blacklist_decision
  BEFORE UPDATE OR DELETE ON youtube_blacklist_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_historical_update();
CREATE INDEX youtube_blacklist_decision_history
  ON youtube_blacklist_decisions(channel_id, session_id, created_at DESC, id DESC);

COMMENT ON TABLE youtube_blacklist_decisions IS
  'Immutable captured blacklist decisions linked to separate message and author plans. The store recomputes literal matches and verifies targets before insertion.';
