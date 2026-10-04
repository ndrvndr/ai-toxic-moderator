-- AI plans remain embedded audit data until executor integration explicitly authorizes them.
CREATE TABLE youtube_ai_action_decisions (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL,
  session_id uuid NOT NULL,
  run_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  classification_id uuid NOT NULL,
  model_result_id uuid REFERENCES youtube_ai_shadow_results(id),
  decision jsonb NOT NULL CHECK (jsonb_typeof(decision) = 'object'),
  blacklist jsonb NOT NULL CHECK (jsonb_typeof(blacklist) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, observation_id),
  FOREIGN KEY (channel_id, session_id, run_id)
    REFERENCES monitoring_runs(channel_id, session_id, id),
  FOREIGN KEY (channel_id, session_id, observation_id, run_id)
    REFERENCES youtube_chat_observations(channel_id, session_id, id, first_observed_run_id),
  FOREIGN KEY (channel_id, session_id, classification_id)
    REFERENCES youtube_chat_classifications(channel_id, session_id, id)
);

CREATE FUNCTION validate_youtube_ai_action_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  observed youtube_chat_observations%ROWTYPE;
  captured monitoring_ai_settings_snapshots%ROWTYPE;
  captured_blacklist monitoring_blacklist_snapshots%ROWTYPE;
  model youtube_ai_shadow_results%ROWTYPE;
  scope jsonb;
  configuration jsonb;
  expected_output jsonb := 'null'::jsonb;
  expected_reason text;
  tier_name text;
  tier_action text;
  threshold_value jsonb := 'null'::jsonb;
  author_status text := 'NOT_SELECTED';
  author_target text;
  policy text;
  plan_scope jsonb;
  plans jsonb := '[]'::jsonb;
  author_plan jsonb;
  expected jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM youtube_chat_classifications WHERE id=NEW.classification_id
      AND channel_id=NEW.channel_id AND session_id=NEW.session_id
      AND observation_id=NEW.observation_id AND run_id=NEW.run_id
  ) THEN
    RAISE EXCEPTION 'AI classification scope does not match' USING ERRCODE='23514';
  END IF;
  SELECT * INTO observed FROM youtube_chat_observations WHERE id=NEW.observation_id
    AND channel_id=NEW.channel_id AND session_id=NEW.session_id AND first_observed_run_id=NEW.run_id;
  IF NOT FOUND OR observed.event_type <> 'textMessageEvent' THEN
    RAISE EXCEPTION 'AI decisions require an observed text message' USING ERRCODE='23514';
  END IF;
  author_target := COALESCE(observed.payload #>> '{authorDetails,channelId}', observed.payload #>> '{snippet,authorChannelId}');
  scope := jsonb_build_object('run_id', NEW.run_id, 'channel_id', NEW.channel_id,
    'session_id', NEW.session_id, 'observation_id', NEW.observation_id,
    'classification_id', NEW.classification_id, 'external_message_id', observed.external_message_id,
    'author_channel_id', author_target);
  SELECT * INTO captured FROM monitoring_ai_settings_snapshots WHERE run_id=NEW.run_id AND channel_id=NEW.channel_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI snapshot is missing' USING ERRCODE='23514'; END IF;
  SELECT * INTO captured_blacklist FROM monitoring_blacklist_snapshots WHERE run_id=NEW.run_id AND channel_id=NEW.channel_id;
  IF NOT FOUND OR NEW.blacklist ->> 'run_id' IS DISTINCT FROM NEW.run_id::text
    OR NEW.blacklist ->> 'channel_id' IS DISTINCT FROM NEW.channel_id::text
    OR NEW.blacklist ->> 'session_id' IS DISTINCT FROM NEW.session_id::text
    OR NEW.blacklist ->> 'classification_id' IS DISTINCT FROM NEW.classification_id::text
    OR NEW.blacklist ->> 'source' IS DISTINCT FROM captured_blacklist.source
    OR NEW.blacklist -> 'blacklist_id' IS DISTINCT FROM COALESCE(to_jsonb(captured_blacklist.blacklist_id), 'null'::jsonb)
    OR NEW.blacklist -> 'blacklist_revision' IS DISTINCT FROM COALESCE(to_jsonb(captured_blacklist.blacklist_revision), 'null'::jsonb)
    OR NOT (NEW.blacklist ? 'selected_rule_id')
  THEN RAISE EXCEPTION 'Blacklist audit scope does not match' USING ERRCODE='23514'; END IF;
  IF NEW.model_result_id IS NOT NULL THEN
    SELECT * INTO model FROM youtube_ai_shadow_results WHERE id=NEW.model_result_id
      AND channel_id=NEW.channel_id AND session_id=NEW.session_id
      AND run_id=NEW.run_id AND observation_id=NEW.observation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'AI result scope does not match' USING ERRCODE='23514'; END IF;
  END IF;
  configuration := captured.configuration;
  IF NEW.blacklist -> 'selected_rule_id' <> 'null'::jsonb THEN
    expected_reason := 'BLACKLIST_MATCH';
  ELSIF configuration IS NULL THEN expected_reason := 'NO_SAVED_POLICY';
  ELSIF configuration -> 'automatic_actions_enabled' = 'false'::jsonb THEN expected_reason := 'AI_DISABLED';
  ELSIF NEW.model_result_id IS NULL THEN expected_reason := 'OUTPUT_MISSING';
  ELSE
    expected_output := to_jsonb(model) - ARRAY['id', 'created_at']::text[];
    IF jsonb_build_object('model_id', model.model_id, 'model_revision', model.model_revision,
      'model_variant', model.model_variant, 'adapter_version', model.adapter_version)
      IS DISTINCT FROM configuration -> 'model' THEN expected_reason := 'MODEL_MISMATCH';
    ELSIF model.status = 'ERROR' THEN expected_reason := 'INFERENCE_ERROR';
    ELSIF model.truncated THEN expected_reason := 'INPUT_TRUNCATED';
    ELSE
      FOREACH tier_name IN ARRAY ARRAY['ban', 'timeout', 'delete'] LOOP
        IF configuration #> ARRAY[tier_name, 'enabled'] = 'true'::jsonb
          AND model.severity_score >= (configuration #>> ARRAY[tier_name, 'threshold'])::double precision THEN
          threshold_value := configuration #> ARRAY[tier_name, 'threshold'];
          tier_action := upper(tier_name);
          EXIT;
        END IF;
      END LOOP;
      expected_reason := CASE WHEN tier_action IS NULL THEN 'NO_THRESHOLD_MET' ELSE 'THRESHOLD_MET' END;
    END IF;
  END IF;
  policy := 'ai-threshold-1-' || NEW.run_id::text;
  IF tier_action IS NOT NULL THEN
    plan_scope := jsonb_build_object('classification_id', NEW.classification_id, 'channel_id', NEW.channel_id,
      'session_id', NEW.session_id, 'reason', 'Model expected severity met the captured ' || tier_name || ' threshold.');
    plans := jsonb_build_array(plan_scope || jsonb_build_object('policy_version', policy || ':message',
      'action', 'DELETE', 'external_message_id', observed.external_message_id));
    IF tier_action <> 'DELETE' THEN
      IF author_target ~ '^UC[A-Za-z0-9_-]{22}$' THEN
        author_status := 'PLANNED';
        author_plan := plan_scope || jsonb_build_object('policy_version', policy || ':author',
          'action', tier_action, 'author_channel_id', author_target);
        IF tier_action = 'TIMEOUT' THEN author_plan := author_plan || jsonb_build_object(
          'duration_seconds', configuration #> '{timeout,duration_seconds}'); END IF;
        plans := plans || jsonb_build_array(author_plan);
      ELSE author_status := 'TARGET_UNAVAILABLE'; END IF;
    END IF;
  END IF;
  expected := jsonb_build_object('planner_version', 'ai-threshold-1', 'policy_version', policy,
    'context', scope, 'snapshot', to_jsonb(captured) - 'captured_at', 'model_output', expected_output,
    'reason_code', expected_reason, 'selected_tier', tier_action, 'selected_threshold', threshold_value,
    'author_action_status', author_status, 'plans', plans);
  IF NEW.decision IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'AI decision must match captured settings, stored output and observed targets' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_youtube_ai_action_decision
  BEFORE INSERT ON youtube_ai_action_decisions FOR EACH ROW EXECUTE FUNCTION validate_youtube_ai_action_decision();
CREATE TRIGGER immutable_youtube_ai_action_decision
  BEFORE UPDATE OR DELETE ON youtube_ai_action_decisions FOR EACH ROW EXECUTE FUNCTION reject_historical_update();
CREATE INDEX youtube_ai_action_decision_history ON youtube_ai_action_decisions(channel_id, session_id, created_at DESC, id DESC);
COMMENT ON TABLE youtube_ai_action_decisions IS
  'Immutable AI decision audit. Embedded plans are not queued or authorized for dispatch. Store recomputes captured blacklist matches before planning.';
