-- Replace author-wide uniqueness with the observation identity added in 014.
-- Locate the old constraint by its columns rather than a generated name.
DO $$
DECLARE
  author_constraint_name text;
BEGIN
  SELECT c.conname
  INTO STRICT author_constraint_name
  FROM pg_constraint c
  WHERE c.conrelid = 'youtube_ban_executions'::regclass
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY k.ordinality)
      FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
        AND a.attnum = k.attnum
    ) = ARRAY['channel_id', 'session_id', 'author_channel_id']::text[];

  EXECUTE format(
    'ALTER TABLE youtube_ban_executions DROP CONSTRAINT %I',
    author_constraint_name
  );
END;
$$;

CREATE INDEX youtube_ban_execution_author_history
  ON youtube_ban_executions(channel_id, session_id, author_channel_id);