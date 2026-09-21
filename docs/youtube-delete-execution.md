# YouTube deletion execution storage

Migration `012_youtube_delete_execution.sql` introduces execution identities and
attempt records. It does not start an executor or enable deletion rules.

## Execution identity

An execution references a DELETE plan and the original classified message.
Database validation rejects substituted channels, sessions, and message IDs.
The identity is immutable and unique by channel, session, and external message ID,
including across classification and action-policy versions. Later plans for the
same message must reuse the execution; the original plan remains its provenance.

## Attempt lifecycle

The executor commits a DISPATCHED attempt before calling YouTube.
DISPATCHED means the request may have been sent; it does not confirm delivery.
Each attempt records an owner UUID and a deadline, then accepts one final result:

- SUCCEEDED: YouTube returned HTTP 204.
- REJECTED: YouTube returned a recognized rejection response.
- NOT_SENT: the adapter confirmed that dispatch did not occur.
- UNKNOWN: the request outcome cannot be established.

Attempt numbers are sequential. Creation locks the execution row. A dispatched,
unknown, or successful attempt blocks subsequent dispatches. A rejected or unsent
attempt permits a new record, but retry eligibility and timing still belong to
the executor. The schema does not automatically retry errors.

Terminal attempts cannot be rewritten. Recovery must mark an expired dispatched
attempt UNKNOWN, never reset it to pending. UNKNOWN currently remains blocked;
reconciliation and any subsequent resolution require a separate audited design.

## Execution store

`DeleteExecutionStore` uses the worker database role and short transactions:

- `ensure` derives the target from the persisted DELETE plan and reuses the
  original execution across policy versions.
- `claim` locks that execution and commits its first DISPATCHED attempt before
  returning the owner, attempt ID, original target, and deadline.
- `complete` records a result only for the matching owner and attempt before
  the database deadline. A false return never permits another network request.
- `recoverExpired` locks bounded batches with SKIP LOCKED and marks expired
  attempts UNKNOWN. It leaves active and terminal attempts unchanged.

The store currently refuses claims for any execution that already has an attempt,
including REJECTED and NOT_SENT. Automatic retry eligibility is not implemented.
Late completion cannot replace UNKNOWN; audited reconciliation remains separate.
This store does not check current monitoring eligibility or Google authorization
on its own. `DeleteExecutor` coordinates it with an injected eligibility resolver,
token store, and deletion adapter. Worker integration is opt-in and disabled by default.

Run `npm run test:delete-execution-store` for database-backed concurrency, ownership,
deduplication, and deadline-recovery checks using the worker role.

## Executor orchestration

`DeleteExecutor` resolves eligibility using the original persisted execution,
loads credentials for that account, and rechecks authorization after token refresh
and after claiming. An account change or failed final check prevents dispatch.
The resolver is mandatory; no allow-all default is provided.

`DeleteEligibilityStore` checks persisted execution identity, original classification
run, text-message target, RUNNING status without a stop request, an open YouTube
session, and a checkpoint without chat completion. Both the original requester and
credential account must still hold OWNER or MODERATOR membership in the channel.
Credentials must contain an exact YouTube write scope; expired access tokens are
allowed here because the token store refreshes them before dispatch. Local membership
and stored scopes do not prove current YouTube permissions; provider rejection remains
possible. No token ciphertext is read by the eligibility query.

The required enable callback must reflect Google authentication and deletion feature
configuration. The worker supplies this callback from its validated startup configuration.
Database-backed eligibility tests run with `npm run test:delete-execution-store`.

Provider calls occur after the claim transaction commits. Cancellation before
dispatch records NOT_SENT when a claim exists. Transport exceptions become UNKNOWN.
Failed or expired result persistence returns RESULT_NOT_RECORDED, never confirmed
success, and never triggers another request. Expired attempts remain recoverable
through the store. The local abort deadline is a best-effort transport bound;
database time remains authoritative for recording results.

These checks cannot eliminate the race between the final authorization read and
the external request. Stopping monitoring cannot retract a request already sent.
Unit tests use injected dependencies and make no Google requests. Run
`npm run test:delete-executor` to verify orchestration failure paths.

## Worker runtime

`YOUTUBE_DELETE_ENABLED` defaults to `false` and requires both `WORKER_ENABLED`
and `GOOGLE_AUTH_ENABLED`. Leave it false while completing the remaining verification.
Configuration is loaded at startup; changing an environment file requires a worker restart.
The existing default action policy still has an empty deletion rule list and produces NONE.
Enabling the executor does not change that policy, but it can process already persisted
DELETE plans whose original monitoring runs are still eligible.

When enabled, the worker validates access to execution and authorization tables and
constructs the candidate store, eligibility store, executor, and coordinator. Each tick
discovers at most one DELETE plan from a RUNNING run without an existing attempt for
the target. A UUID cursor advances past skipped plans and wraps on exhaustion. This is
a bounded round-robin scan, not chronological ordering or a guaranteed delivery latency.
Eligibility is checked again by the executor. Multiple workers may discover the same
plan; execution identity and claim transactions arbitrate dispatch ownership.

Ingestion and deletion use independent loops with a one-second delay after each tick.
Shutdown aborts both loops and waits for in-flight work before closing the shared pool.
No automatic retries are scheduled. Recovery storage exists, but periodic recovery is
not yet connected to the runtime; expired dispatches remain blocked until recovery runs.

Run `npm run test:delete-coordinator`, `npm run test:worker-runtime`, and
`npm run test:delete-execution-store` for configuration, scheduling, shutdown, and
database-backed candidate discovery checks. These tests do not delete YouTube messages.

## Remaining implementation

- Explicit retry eligibility and audited reconciliation.
- Periodic expired-attempt recovery in the worker runtime.
- Dashboard status delivery and controlled live verification.

Schema constraints prevent invalid records; they do not prove that a network
request was sent exactly once.
