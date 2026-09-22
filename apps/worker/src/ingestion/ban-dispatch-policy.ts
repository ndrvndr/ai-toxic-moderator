/**
 * Requires an outer youtube_chat_observations alias named "o".
 * Discovery uses this predicate as an optimization.
 * Claim repeats it under an author-scoped transaction lock.
 */
export const BAN_DISPATCH_ALLOWED_SQL = `
  NOT EXISTS (
    SELECT 1
    FROM youtube_ban_executions history
    JOIN youtube_ban_attempts attempt
      ON attempt.execution_id = history.id
    WHERE history.channel_id = o.channel_id
      AND history.session_id = o.session_id
      AND history.author_channel_id = COALESCE(
        o.payload #>> '{authorDetails,channelId}',
        o.payload #>> '{snippet,authorChannelId}'
      )
      AND (
        attempt.status IN ('DISPATCHED', 'UNKNOWN')
        OR (
          attempt.status = 'SUCCEEDED'
          AND (
            history.action = 'BAN'
            OR (
              history.action = 'TIMEOUT'
              AND (
                EXTRACT(EPOCH FROM (
                  clock_timestamp() - attempt.finished_at
                )) <= history.duration_seconds
                OR EXTRACT(EPOCH FROM (
                  o.published_at - attempt.finished_at
                )) <= history.duration_seconds
              )
            )
          )
        )
      )
  )
`;
