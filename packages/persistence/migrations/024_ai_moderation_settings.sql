-- Validate the same explicit configuration shape used by the shared contracts.
CREATE FUNCTION valid_ai_moderation_configuration(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  tier_name text;
  tier jsonb;
  threshold_value numeric;
  duration_value numeric;
  model jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (
    value -> 'schema_version' = '1'::jsonb
    AND jsonb_typeof(value -> 'automatic_actions_enabled') = 'boolean'
    AND value ->> 'score_metric' = 'EXPECTED_SEVERITY'
    AND value - ARRAY['schema_version', 'automatic_actions_enabled', 'model',
      'score_metric', 'delete', 'timeout', 'ban']::text[] = '{}'::jsonb
  ) IS NOT TRUE THEN RETURN false; END IF;

  model := value -> 'model';
  IF jsonb_typeof(model) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (
    jsonb_typeof(model -> 'model_id') = 'string'
    AND length(model ->> 'model_id') BETWEEN 1 AND 200
    AND model ->> 'model_id' ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    AND jsonb_typeof(model -> 'model_revision') = 'string'
    AND model ->> 'model_revision' ~ '^[a-f0-9]{40}$'
    AND model -> 'model_variant' = '"INT8"'::jsonb
    AND jsonb_typeof(model -> 'adapter_version') = 'string'
    AND length(model ->> 'adapter_version') BETWEEN 1 AND 128
    AND model ->> 'adapter_version' ~ '^[A-Za-z0-9_.-]+$'
    AND model - ARRAY['model_id', 'model_revision', 'model_variant', 'adapter_version']::text[] = '{}'::jsonb
  ) IS NOT TRUE THEN RETURN false; END IF;

  FOREACH tier_name IN ARRAY ARRAY['delete', 'timeout', 'ban'] LOOP
    tier := value -> tier_name;
    IF jsonb_typeof(tier) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF jsonb_typeof(tier -> 'enabled') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(tier -> 'threshold') IS DISTINCT FROM 'number'
    THEN RETURN false; END IF;
    threshold_value := (tier ->> 'threshold')::numeric;
    IF threshold_value < 0 OR threshold_value > 1 THEN RETURN false; END IF;
    IF tier_name = 'timeout' THEN
      IF jsonb_typeof(tier -> 'duration_seconds') IS DISTINCT FROM 'number'
        OR tier - ARRAY['enabled', 'threshold', 'duration_seconds']::text[] <> '{}'::jsonb
      THEN RETURN false; END IF;
      duration_value := (tier ->> 'duration_seconds')::numeric;
      IF duration_value <> trunc(duration_value) OR duration_value < 1 OR duration_value > 86400
      THEN RETURN false; END IF;
    ELSIF tier - ARRAY['enabled', 'threshold']::text[] <> '{}'::jsonb THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN (value #>> '{delete,threshold}')::numeric < (value #>> '{timeout,threshold}')::numeric
    AND (value #>> '{timeout,threshold}')::numeric < (value #>> '{ban,threshold}')::numeric;
END;
$$;

CREATE TABLE channel_ai_moderation_settings (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channels(id),
  revision integer NOT NULL CHECK (revision > 0),
  configuration jsonb NOT NULL CHECK (valid_ai_moderation_configuration(configuration) IS TRUE),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (channel_id, revision),
  UNIQUE (channel_id, id, revision)
);

CREATE FUNCTION validate_ai_moderation_settings_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_revision bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-moderation-settings:' || NEW.channel_id::text, 0));
  SELECT COALESCE(MAX(revision)::bigint, 0) + 1 INTO expected_revision
  FROM channel_ai_moderation_settings WHERE channel_id = NEW.channel_id;
  IF NEW.revision <> expected_revision THEN
    RAISE EXCEPTION 'AI settings revisions must be consecutive within a channel' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_ai_moderation_settings_revision
  BEFORE INSERT ON channel_ai_moderation_settings
  FOR EACH ROW EXECUTE FUNCTION validate_ai_moderation_settings_revision();

CREATE TRIGGER immutable_ai_moderation_settings
  BEFORE UPDATE OR DELETE ON channel_ai_moderation_settings
  FOR EACH ROW EXECUTE FUNCTION reject_historical_update();

CREATE TABLE monitoring_ai_settings_snapshots (
  run_id uuid PRIMARY KEY,
  channel_id uuid NOT NULL,
  settings_id uuid,
  settings_revision integer,
  configuration jsonb,
  source text NOT NULL CHECK (source IN ('SAVED', 'DEFAULT', 'LEGACY')),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (channel_id, run_id) REFERENCES monitoring_runs(channel_id, id),
  FOREIGN KEY (channel_id, settings_id, settings_revision)
    REFERENCES channel_ai_moderation_settings(channel_id, id, revision),
  CHECK (
    (source = 'SAVED' AND settings_id IS NOT NULL AND settings_revision IS NOT NULL
      AND settings_revision > 0 AND configuration IS NOT NULL
      AND valid_ai_moderation_configuration(configuration) IS TRUE)
    OR
    (source IN ('DEFAULT', 'LEGACY') AND settings_id IS NULL
      AND settings_revision IS NULL AND configuration IS NULL)
  )
);

-- Do not invent a model or retrospectively assign AI policies to historical runs.
INSERT INTO monitoring_ai_settings_snapshots(run_id, channel_id, source)
SELECT id, channel_id, 'LEGACY' FROM monitoring_runs;

CREATE FUNCTION validate_monitoring_ai_settings_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'LEGACY' THEN
    RAISE EXCEPTION 'Legacy AI snapshots are reserved for migration backfill' USING ERRCODE = '23514';
  END IF;
  IF NEW.source = 'SAVED' AND NOT EXISTS (
    SELECT 1 FROM channel_ai_moderation_settings
    WHERE channel_id = NEW.channel_id AND id = NEW.settings_id
      AND revision = NEW.settings_revision AND configuration = NEW.configuration
  ) THEN
    RAISE EXCEPTION 'AI snapshot must match its immutable settings revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_monitoring_ai_settings_snapshot
  BEFORE INSERT ON monitoring_ai_settings_snapshots
  FOR EACH ROW EXECUTE FUNCTION validate_monitoring_ai_settings_snapshot();

CREATE TRIGGER immutable_monitoring_ai_settings_snapshot
  BEFORE UPDATE OR DELETE ON monitoring_ai_settings_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_historical_update();

CREATE FUNCTION capture_monitoring_ai_settings_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  selected_settings channel_ai_moderation_settings%ROWTYPE;
BEGIN
  -- Capture the latest committed revision visible here without taking the settings
  -- writer's advisory lock after monitoring has locked membership rows.
  SELECT * INTO selected_settings FROM channel_ai_moderation_settings
  WHERE channel_id = NEW.channel_id ORDER BY revision DESC LIMIT 1;
  IF FOUND THEN
    INSERT INTO monitoring_ai_settings_snapshots(
      run_id, channel_id, settings_id, settings_revision, configuration, source
    ) VALUES (
      NEW.id, NEW.channel_id, selected_settings.id, selected_settings.revision,
      selected_settings.configuration, 'SAVED'
    );
  ELSE
    INSERT INTO monitoring_ai_settings_snapshots(run_id, channel_id, source)
    VALUES (NEW.id, NEW.channel_id, 'DEFAULT');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capture_monitoring_ai_settings_snapshot
  AFTER INSERT ON monitoring_runs
  FOR EACH ROW EXECUTE FUNCTION capture_monitoring_ai_settings_snapshot();

COMMENT ON TABLE monitoring_ai_settings_snapshots IS
  'Immutable AI policy captured with run creation. NULL configuration means no AI enforcement policy. Worker action integration is not implemented.';
