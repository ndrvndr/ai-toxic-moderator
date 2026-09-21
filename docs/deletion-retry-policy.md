# Deletion retry and reconciliation policy

## Current behavior

Every execution with an attempt is blocked from further dispatch, including REJECTED
and NOT_SENT. The schema permits another attempt after these two statuses, but the
application does not schedule or claim one. Worker restarts and new policy versions
do not authorize redispatch.

| Persisted status                | Current behavior                          | Prerequisite for any future retry                                          |
| ------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| DISPATCHED                      | Wait; recover expired attempts as UNKNOWN | No retry while outcome is unresolved                                       |
| SUCCEEDED                       | Terminal                                  | Never repeat the confirmed action                                          |
| UNKNOWN                         | Block redispatch                          | Audited reconciliation design; missing confirmation does not prove failure |
| NOT_SENT / REQUEST_CANCELLED    | Block redispatch                          | Fresh eligibility, cancellation cleared, bounded retry policy              |
| NOT_SENT / INVALID_REQUEST      | Block redispatch                          | Correct input/configuration; no unchanged request loop                     |
| REJECTED / RECONNECT_REQUIRED   | Block redispatch                          | Repaired authorization and fresh eligibility                               |
| REJECTED / YOUTUBE_FORBIDDEN    | Block redispatch                          | Verified permission repair                                                 |
| REJECTED / MESSAGE_NOT_FOUND    | Terminal for automatic scheduling         | Do not label as confirmed deletion; no automatic retry                     |
| REJECTED / INVALID_REQUEST      | Block redispatch                          | Correct the underlying issue                                               |
| REJECTED / YOUTUBE_RATE_LIMITED | Block redispatch                          | Persisted backoff, retry budget, and fresh eligibility                     |

Transport errors, interruptions, unexpected responses, and ambiguous server failures
remain UNKNOWN under the existing adapter. Failed result persistence cannot authorize
another provider request.

## Implementation boundary

This policy records current behavior and prerequisites for future retries. It does
not enable retries or add a reconciliation endpoint. Before enabling retries, implement
durable scheduling, an attempt budget, atomic claim arbitration, original-run and
account-access revalidation, and concurrency, shutdown, expiry, and restart tests.

Preserve prior attempts. Do not rewrite terminal records or delete executions to bypass
deduplication. A message disappearing from YouTube alone does not prove this execution
succeeded. Future reconciliation records must separately capture actor, timestamp,
evidence, and resolution; authorizing another action requires explicit semantics and tests.

Other messages continue through automatic moderation while an uncertain target stays
blocked. This policy does not require human approval for every moderation action.
