-- Records when ingestion observed the end of the chat.
-- Persisted atomically with the final batch and checkpoint.
ALTER TABLE youtube_chat_checkpoints
  ADD COLUMN chat_ended_at timestamptz;