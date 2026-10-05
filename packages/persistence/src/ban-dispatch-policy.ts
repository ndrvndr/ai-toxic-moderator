/**
 * Requires an outer youtube_chat_observations alias named "o".
 * Returns one blocking reason, or NULL when author history allows dispatch.
 * This does not replace authorization, configuration, or run-state checks.
 */
export const BAN_DISPATCH_BLOCK_REASON_SQL = `
  (
    SELECT blocked.reason
    FROM (
      SELECT
        CASE
          WHEN attempt.status = 'UNKNOWN'
            THEN 'PREVIOUS_OUTCOME_UNKNOWN'
          WHEN attempt.status = 'SUCCEEDED' AND history.action = 'BAN'
            AND removal.finished_at IS NULL
            THEN 'AUTHOR_ALREADY_BANNED'
          WHEN attempt.status = 'SUCCEEDED' AND history.action = 'BAN'
            AND removal.finished_at IS NOT NULL
            AND (o.published_at <= removal.finished_at OR o.received_at <= removal.finished_at)
            THEN 'MESSAGE_BEFORE_UNBAN'
          WHEN attempt.status = 'SUCCEEDED'
            AND history.action = 'TIMEOUT'
            AND EXTRACT(EPOCH FROM (
              o.published_at - attempt.finished_at
            )) <= history.duration_seconds
            THEN 'MESSAGE_BEFORE_TIMEOUT_END'
          WHEN attempt.status = 'DISPATCHED'
            THEN 'AUTHOR_ACTION_IN_PROGRESS'
          WHEN attempt.status = 'SUCCEEDED'
            AND history.action = 'TIMEOUT'
            AND EXTRACT(EPOCH FROM (
              clock_timestamp() - attempt.finished_at
            )) <= history.duration_seconds
            THEN 'TIMEOUT_WINDOW_ACTIVE'
          ELSE NULL
        END AS reason
      FROM youtube_ban_executions history
      JOIN youtube_ban_attempts attempt
        ON attempt.execution_id = history.id
      LEFT JOIN LATERAL (
        SELECT u.finished_at
        FROM youtube_unban_requests u
        WHERE u.ban_attempt_id = attempt.id
          AND u.execution_id = history.id
          AND u.channel_id = history.channel_id
          AND u.session_id = history.session_id
          AND u.status IN ('SUCCEEDED', 'USER_CONFIRMED')
        LIMIT 1
      ) removal ON true
      WHERE history.channel_id = o.channel_id
        AND history.session_id = o.session_id
        AND history.author_channel_id = COALESCE(
          o.payload #>> '{authorDetails,channelId}',
          o.payload #>> '{snippet,authorChannelId}'
        )
    ) blocked
    WHERE blocked.reason IS NOT NULL
    ORDER BY CASE blocked.reason
      WHEN 'PREVIOUS_OUTCOME_UNKNOWN' THEN 1
      WHEN 'AUTHOR_ALREADY_BANNED' THEN 2
      WHEN 'MESSAGE_BEFORE_UNBAN' THEN 3
      WHEN 'MESSAGE_BEFORE_TIMEOUT_END' THEN 4
      WHEN 'AUTHOR_ACTION_IN_PROGRESS' THEN 5
      WHEN 'TIMEOUT_WINDOW_ACTIVE' THEN 6
    END
    LIMIT 1
  )
`;

export const BAN_DISPATCH_ALLOWED_SQL = `
  (${BAN_DISPATCH_BLOCK_REASON_SQL}) IS NULL
`;
