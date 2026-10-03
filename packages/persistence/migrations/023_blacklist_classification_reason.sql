ALTER TABLE youtube_chat_classifications
  DROP CONSTRAINT youtube_chat_classifications_reason_code_check,
  DROP CONSTRAINT youtube_chat_classifications_check;

ALTER TABLE youtube_chat_classifications
  ADD CONSTRAINT youtube_chat_classifications_reason_code_check CHECK (
    reason_code IN ('NO_RULE_MATCH', 'CONTEXT_REQUIRED', 'GAMBLING_PROMOTION',
      'DIRECT_INSULT', 'PROCESSING_FAILED', 'BLACKLIST_MATCH')
  ),
  ADD CONSTRAINT youtube_classification_decision_consistency CHECK ((
    (outcome = 'ALLOW' AND primary_category IS NULL AND severity = 0
      AND reason_code = 'NO_RULE_MATCH')
    OR (outcome IN ('REVIEW', 'ACTION_REQUIRED') AND primary_category IS NOT NULL
      AND severity BETWEEN 1 AND 4 AND reason_code <> 'BLACKLIST_MATCH')
    OR (outcome = 'ERROR' AND primary_category IS NULL AND severity IS NULL
      AND reason_code = 'PROCESSING_FAILED')
    OR (outcome = 'ACTION_REQUIRED' AND primary_category IS NULL AND severity IS NULL
      AND reason_code = 'BLACKLIST_MATCH' AND signals = '[]'::jsonb)
  ) IS TRUE);
