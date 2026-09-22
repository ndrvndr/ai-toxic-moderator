/**
 * SQL predicate for an attempt aliased as `a`. Only explicit rate-limit rejections
 * qualify. Persisted completion time and attempt number survive worker restarts.
 * Maximum three total attempts, with minimum delays of 60 and 120 seconds.
 */
export const DELETE_RETRY_DUE_SQL = `(
  a.status = 'REJECTED'
  AND a.http_status = 429
  AND a.error_code = 'YOUTUBE_RATE_LIMITED'
  AND a.attempt_number IN (1, 2)
  AND a.finished_at IS NOT NULL
  AND a.finished_at + CASE a.attempt_number
    WHEN 1 THEN interval '60 seconds'
    ELSE interval '120 seconds'
  END <= clock_timestamp()
)`;
