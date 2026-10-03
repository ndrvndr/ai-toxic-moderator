-- A settings snapshot is captured atomically with each new monitoring run.
ALTER TABLE monitoring_runs
  ADD CONSTRAINT monitoring_runs_channel_identity UNIQUE (channel_id, id);

CREATE TABLE monitoring_settings_snapshots (
  run_id uuid PRIMARY KEY,
  channel_id uuid NOT NULL,
  settings_id uuid,
  settings_revision integer,
  configuration jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('SAVED', 'DEFAULT', 'LEGACY')),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (channel_id, run_id) REFERENCES monitoring_runs(channel_id, id),
  FOREIGN KEY (channel_id, settings_id)
    REFERENCES channel_moderation_settings(channel_id, id),
  CHECK (
    (source = 'SAVED' AND settings_id IS NOT NULL
      AND settings_revision IS NOT NULL AND settings_revision > 0)
    OR
    (source IN ('DEFAULT', 'LEGACY') AND settings_id IS NULL
      AND settings_revision IS NULL
      AND configuration = '{"schema_version":1,"automatic_actions_enabled":false,"rules":[]}'::jsonb)
  )
);

-- Prior runs have no recorded settings selection. Do not assign current settings
-- retrospectively or represent this fallback as their historical enforcement policy.
INSERT INTO monitoring_settings_snapshots (
  run_id, channel_id, configuration, source
)
SELECT id, channel_id,
  '{"schema_version":1,"automatic_actions_enabled":false,"rules":[]}'::jsonb,
  'LEGACY'
FROM monitoring_runs;

CREATE FUNCTION validate_monitoring_settings_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'LEGACY' THEN
    RAISE EXCEPTION 'Legacy snapshots are reserved for migration backfill'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source = 'SAVED' AND NOT EXISTS (
    SELECT 1 FROM channel_moderation_settings
    WHERE channel_id = NEW.channel_id AND id = NEW.settings_id
      AND revision = NEW.settings_revision AND configuration = NEW.configuration
  ) THEN
    RAISE EXCEPTION 'Snapshot must match its immutable settings revision'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_monitoring_settings_snapshot
  BEFORE INSERT ON monitoring_settings_snapshots
  FOR EACH ROW EXECUTE FUNCTION validate_monitoring_settings_snapshot();

CREATE TRIGGER immutable_monitoring_settings_snapshot
  BEFORE UPDATE OR DELETE ON monitoring_settings_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_historical_update();

CREATE FUNCTION capture_monitoring_settings_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  selected_settings channel_moderation_settings%ROWTYPE;
BEGIN
  -- Read the latest committed revision visible here, without acquiring the
  -- settings writer's advisory lock after monitoring has locked membership rows.
  SELECT * INTO selected_settings FROM channel_moderation_settings
  WHERE channel_id = NEW.channel_id ORDER BY revision DESC LIMIT 1;

  IF FOUND THEN
    INSERT INTO monitoring_settings_snapshots (
      run_id, channel_id, settings_id, settings_revision, configuration, source
    ) VALUES (
      NEW.id, NEW.channel_id, selected_settings.id, selected_settings.revision,
      selected_settings.configuration, 'SAVED'
    );
  ELSE
    INSERT INTO monitoring_settings_snapshots (
      run_id, channel_id, configuration, source
    ) VALUES (
      NEW.id, NEW.channel_id,
      '{"schema_version":1,"automatic_actions_enabled":false,"rules":[]}'::jsonb,
      'DEFAULT'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capture_monitoring_settings_snapshot
  AFTER INSERT ON monitoring_runs
  FOR EACH ROW EXECUTE FUNCTION capture_monitoring_settings_snapshot();

COMMENT ON TABLE monitoring_settings_snapshots IS
  'Immutable settings selection per run. LEGACY records do not describe prior enforcement. Worker integration is required before saved policies affect actions.';
