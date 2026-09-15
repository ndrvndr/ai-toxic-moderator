ALTER TABLE youtube_chat_checkpoints
  ADD COLUMN revision bigint NOT NULL DEFAULT 0
  CHECK (revision >= 0);