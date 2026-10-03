CREATE TABLE channel_moderation_settings (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channels(id),
  revision integer NOT NULL CHECK (revision > 0),
  configuration jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (channel_id, revision),
  UNIQUE (channel_id, id),
  CONSTRAINT moderation_settings_configuration_shape CHECK (
    CASE WHEN jsonb_typeof(configuration) = 'object' THEN
      (
        configuration -> 'schema_version' = '1'::jsonb
        AND jsonb_typeof(configuration -> 'automatic_actions_enabled') = 'boolean'
        AND CASE WHEN jsonb_typeof(configuration -> 'rules') = 'array' THEN
          jsonb_array_length(configuration -> 'rules') <= 100
        ELSE false END
        AND configuration - ARRAY[
          'schema_version', 'automatic_actions_enabled', 'rules'
        ]::text[] = '{}'::jsonb
      ) IS TRUE
    ELSE false END
  )
);

CREATE FUNCTION validate_moderation_settings_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_revision bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('moderation-settings:' || NEW.channel_id::text, 0)
  );

  SELECT COALESCE(MAX(revision)::bigint, 0) + 1 INTO expected_revision
  FROM channel_moderation_settings
  WHERE channel_id = NEW.channel_id;

  IF NEW.revision <> expected_revision THEN
    RAISE EXCEPTION 'Settings revisions must be consecutive within a channel'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_moderation_settings_revision
  BEFORE INSERT ON channel_moderation_settings
  FOR EACH ROW EXECUTE FUNCTION validate_moderation_settings_revision();

CREATE TRIGGER immutable_moderation_settings
  BEFORE UPDATE OR DELETE ON channel_moderation_settings
  FOR EACH ROW EXECUTE FUNCTION reject_historical_update();

COMMENT ON TABLE channel_moderation_settings IS
  'Immutable per-channel configuration revisions. Full action configuration
   validation is performed by the settings store before insertion.';
