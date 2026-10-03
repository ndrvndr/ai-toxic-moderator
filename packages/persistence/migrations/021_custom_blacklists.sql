-- Keep blacklist revisions separate from the existing immutable settings format.
CREATE TABLE channel_custom_blacklists (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channels(id),
  revision integer NOT NULL CHECK (revision > 0),
  configuration jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (channel_id, revision),
  UNIQUE (channel_id, id, revision),
  CONSTRAINT custom_blacklist_configuration_shape CHECK (
    CASE WHEN jsonb_typeof(configuration) = 'object' THEN
      (
        configuration -> 'schema_version' = '1'::jsonb
        AND jsonb_typeof(configuration -> 'enabled') = 'boolean'
        AND CASE WHEN jsonb_typeof(configuration -> 'rules') = 'array' THEN
          jsonb_array_length(configuration -> 'rules') <= 100
        ELSE false END
        AND configuration - ARRAY['schema_version', 'enabled', 'rules']::text[] = '{}'::jsonb
      ) IS TRUE
    ELSE false END
  )
);

CREATE FUNCTION validate_custom_blacklist_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_revision bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('custom-blacklist:' || NEW.channel_id::text, 0)
  );
  SELECT COALESCE(MAX(revision)::bigint, 0) + 1 INTO expected_revision
  FROM channel_custom_blacklists WHERE channel_id = NEW.channel_id;
  IF NEW.revision <> expected_revision THEN
    RAISE EXCEPTION 'Blacklist revisions must be consecutive within a channel'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_custom_blacklist_revision
  BEFORE INSERT ON channel_custom_blacklists
  FOR EACH ROW EXECUTE FUNCTION validate_custom_blacklist_revision();

CREATE TRIGGER immutable_custom_blacklist
  BEFORE UPDATE OR DELETE ON channel_custom_blacklists
  FOR EACH ROW EXECUTE FUNCTION reject_historical_update();

CREATE TABLE monitoring_blacklist_snapshots (
  run_id uuid PRIMARY KEY,
  channel_id uuid NOT NULL,
  blacklist_id uuid,
  blacklist_revision integer,
  configuration jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('SAVED', 'DEFAULT', 'LEGACY')),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (channel_id, run_id) REFERENCES monitoring_runs(channel_id, id),
  FOREIGN KEY (channel_id, blacklist_id, blacklist_revision)
    REFERENCES channel_custom_blacklists(channel_id, id, revision),
  CHECK (
    (source = 'SAVED' AND blacklist_id IS NOT NULL
      AND blacklist_revision IS NOT NULL AND blacklist_revision > 0)
    OR
    (source IN ('DEFAULT', 'LEGACY') AND blacklist_id IS NULL
      AND blacklist_revision IS NULL
      AND configuration = '{"schema_version":1,"enabled":false,"rules":[]}'::jsonb)
  )
);

-- Historical runs never inherit a newly configured blacklist retrospectively.
INSERT INTO monitoring_blacklist_snapshots(run_id, channel_id, configuration, source)
SELECT id, channel_id, '{"schema_version":1,"enabled":false,"rules":[]}'::jsonb, 'LEGACY'
FROM monitoring_runs;

CREATE FUNCTION validate_monitoring_blacklist_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'LEGACY' THEN
    RAISE EXCEPTION 'Legacy blacklist snapshots are reserved for migration backfill'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.source = 'SAVED' AND NOT EXISTS (
    SELECT 1 FROM channel_custom_blacklists
    WHERE channel_id = NEW.channel_id AND id = NEW.blacklist_id
      AND revision = NEW.blacklist_revision AND configuration = NEW.configuration
  ) THEN
    RAISE EXCEPTION 'Snapshot must match its immutable blacklist revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_monitoring_blacklist_snapshot
  BEFORE INSERT ON monitoring_blacklist_snapshots
  FOR EACH ROW EXECUTE FUNCTION validate_monitoring_blacklist_snapshot();

CREATE TRIGGER immutable_monitoring_blacklist_snapshot
  BEFORE UPDATE OR DELETE ON monitoring_blacklist_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_historical_update();

CREATE FUNCTION capture_monitoring_blacklist_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  selected_blacklist channel_custom_blacklists%ROWTYPE;
BEGIN
  -- Use the latest committed revision visible to this statement. Do not acquire
  -- the writer's advisory lock after monitoring has locked membership rows.
  SELECT * INTO selected_blacklist FROM channel_custom_blacklists
  WHERE channel_id = NEW.channel_id ORDER BY revision DESC LIMIT 1;
  IF FOUND THEN
    INSERT INTO monitoring_blacklist_snapshots(
      run_id, channel_id, blacklist_id, blacklist_revision, configuration, source
    ) VALUES (
      NEW.id, NEW.channel_id, selected_blacklist.id, selected_blacklist.revision,
      selected_blacklist.configuration, 'SAVED'
    );
  ELSE
    INSERT INTO monitoring_blacklist_snapshots(run_id, channel_id, configuration, source)
    VALUES (NEW.id, NEW.channel_id,
      '{"schema_version":1,"enabled":false,"rules":[]}'::jsonb, 'DEFAULT');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capture_monitoring_blacklist_snapshot
  AFTER INSERT ON monitoring_runs
  FOR EACH ROW EXECUTE FUNCTION capture_monitoring_blacklist_snapshot();

COMMENT ON TABLE channel_custom_blacklists IS
  'Immutable blacklist revisions. The store validates individual patterns and actions before insertion.';
COMMENT ON TABLE monitoring_blacklist_snapshots IS
  'Blacklist revision captured atomically with a monitoring run. Enforcement requires worker integration.';
