/** Uses scoped observation alias o; explicit built-in and blacklist actions take priority. */
export const AI_UNOPPOSED_SQL = `NOT EXISTS (
  SELECT 1 FROM youtube_moderation_action_plans prior
  JOIN youtube_chat_classifications prior_c ON prior_c.id=prior.classification_id
    AND prior_c.channel_id=prior.channel_id AND prior_c.session_id=prior.session_id
  WHERE prior_c.observation_id=o.id AND prior.channel_id=o.channel_id
    AND prior.session_id=o.session_id AND prior.action IN ('DELETE','TIMEOUT','BAN')
    AND prior.policy_version NOT LIKE 'ai-%'
)`;
