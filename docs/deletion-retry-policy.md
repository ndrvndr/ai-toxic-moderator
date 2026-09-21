# Deletion retry and reconciliation policy

## Current behavior

Only REJECTED / HTTP 429 / YOUTUBE_RATE_LIMITED qualifies for automatic retry.
There are at most three total attempts per execution: wait at least 60 seconds after
the first result and 120 seconds after the second. The schedule uses database time,
persisted completion timestamps, and attempt numbers. Restarting the worker or
changing policy versions does not reset the budget. Other attempts remain blocked.

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
| REJECTED / YOUTUBE_RATE_LIMITED | Bounded retry for HTTP 429                | Backoff, at most three total attempts, and fresh eligibility               |

Transport errors, interruptions, unexpected responses, and ambiguous server failures
remain UNKNOWN under the existing adapter. Failed result persistence cannot authorize
another provider request.

## Implementation boundary

Candidate discovery and claim arbitration share one retry predicate. Claim creation
locks the execution before checking its latest attempt and consuming the next number.
Every retry uses the existing executor's original-run and account-access revalidation.
Retries require deletion dispatch to be enabled and publish transactional chat updates.

Other retry categories and reconciliation endpoints remain unimplemented. Backoff is
fixed per target; provider Retry-After parsing, jitter, and project-wide rate limiting
are not implemented. Independent targets can therefore still encounter rate limits.
The successful controlled live test does not establish that live 429 retries passed.

Preserve prior attempts. Do not rewrite terminal records or delete executions to bypass
deduplication. A message disappearing from YouTube alone does not prove this execution
succeeded. Future reconciliation records must separately capture actor, timestamp,
evidence, and resolution; authorizing another action requires explicit semantics and tests.

Other messages continue through automatic moderation while an uncertain target stays
blocked. This policy does not require human approval for every moderation action.
