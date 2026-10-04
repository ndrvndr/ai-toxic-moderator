# AI operational status

## Step 1: shared contract

`aiOperationalStatus` describes automatic AI processing for one authorized channel. It is separate from ingestion state, per-message inference results, saved AI action decisions, and provider execution outcomes. The worker publishes reports through the store in an independent runtime loop. An authenticated endpoint reads these reports; the dashboard indicator is still pending.

| State               | Reason                    | Meaning                                                                                                  | Run scope                                             |
| ------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `DISABLED`          | `WORKER_AI_DISABLED`      | Automatic AI is disabled in worker configuration.                                                        | None                                                  |
| `DISABLED`          | `RUN_AI_DISABLED`         | The run captured disabled AI settings.                                                                   | Required                                              |
| `WAITING`           | `NO_ELIGIBLE_RUN`         | No eligible active run is available.                                                                     | None                                                  |
| `ACTIVE`            | `RUN_SELECTED`            | An eligible run is selected for the pipeline. This does not promise successful inference or enforcement. | Required                                              |
| `MODEL_MISMATCH`    | `CAPTURED_MODEL_MISMATCH` | Captured model identity differs from the worker's available model identity.                              | Required                                              |
| `CAPACITY_EXCEEDED` | `MULTIPLE_ELIGIBLE_RUNS`  | The single-stream worker cannot select one of multiple eligible runs.                                    | None                                                  |
| `ERROR`             | `PROCESSING_FAILED`       | Discovery or processing failed; an allowlisted error code identifies the failure class.                  | Required when the failed run is known; otherwise none |

Channel scope is always required. Run and session IDs must either both be present or both be null. The persistence layer validates the run/session/channel relationship with a composite foreign key. Current membership must still be checked by the future discovery integration and endpoint. Capacity reports must not expose identifiers or counts belonging to other channels.

`error_code` is null outside `ERROR`. Supported error codes are `MODEL_UNAVAILABLE`, `INFERENCE_FAILED`, `INFERENCE_TIMEOUT`, `INVALID_OUTPUT`, `DATABASE_UNAVAILABLE`, and `PIPELINE_FAILED`. Raw exceptions, stack traces, credentials, process IDs, and connection details are not public fields. Model mismatch is a configuration state, not a failed inference result.

## Heartbeat and API freshness

`updated_at` records the last state/scope/reason/error change. `heartbeat_at` records the worker's most recent liveness report and must not precede `updated_at`. Heartbeat writes need not create live-feed events or change the state-change timestamp.

`aiOperationalStatusResponse` wraps the report with the requested channel, `checked_at`, `stale_after_ms`, and availability:

| Availability | Meaning                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN`    | No report is available. `report` must be null; this does not prove that AI is disabled or the worker is stopped.                                                      |
| `ONLINE`     | A report exists and its heartbeat age is less than `stale_after_ms`.                                                                                                  |
| `STALE`      | Heartbeat age is at least `stale_after_ms`. The last report remains available for diagnosis, but its stored `ACTIVE` state must not be displayed as currently active. |

The API assesses freshness using a shared server/database time source. Browser time must not decide availability. `checked_at` cannot precede the heartbeat. The contract permits an integer interval between 1 and 300000 milliseconds; the status store uses 30000 milliseconds. Database read errors must follow the safe API error path, rather than masquerading as `UNKNOWN`.

Freshness is not inference progress. A live heartbeat can coexist with processing errors or an empty chat backlog. Likewise, a stale heartbeat does not establish that a provider request failed and must not trigger an automatic moderation retry.

## Step 2: persistence and ownership

Migration `026_ai_operational_status.sql` adds one mutable current report per channel. State, reason, safe error code, optional run/session scope, and heartbeat are updated atomically. Composite foreign keys prevent cross-channel run references and substituted sessions. Database checks mirror the public state combinations; the table does not store raw errors or credentials.

`AiOperationalStatusStore.claim(channelId)` acquires an expired or missing report lease and initializes `WAITING`. It returns a private owner/generation token, or null while another live claim exists. The lease lasts 30 seconds. Even the same owner must retain its existing token rather than repeatedly claiming a live report. After expiry, a new claim advances the generation and clears the old run scope. A restarted worker with a new owner may wait up to 30 seconds before taking over.

`publish(lease, update)` validates the public state fields and updates the report only while the owner/generation token is current and unexpired. A lost or expired token returns null; malformed input or database failures propagate. These status leases fence reporting only: they do not claim ingestion ownership or authorize moderation dispatch.

A database trigger assigns heartbeat, expiry, and state-change timestamps after acquiring the row lock. Client clock fields are rejected by the store and overridden by the database trigger. Publishing the same state renews heartbeat/expiry while preserving `updated_at`; state, scope, reason, error, or owner-generation changes advance `updated_at`. Ownership changes require expiry and the next generation. No live-feed event is created by these writes.

The worker role receives SELECT/INSERT/UPDATE on this table and cannot DELETE reports. The API role receives SELECT only. Table privileges do not establish end-user authorization; the future endpoint must check membership and project only the public contract, excluding owner, generation, and expiry internals.

Before connecting this store in the application, apply the migration and refresh the managed roles:

```powershell
npm run build:core
npm run db:migrate
npm run db:runtime
npm run db:worker
```

## Step 3: independent worker reporting

`AiOperationalStatusReader` scans connected YouTube channels, including channels with no monitoring history. For each channel it inspects current `RUNNING` runs using the same lifecycle and requester/credential membership boundaries as automatic discovery. Disabled/default/legacy captured settings produce `RUN_AI_DISABLED`; enabled settings with a different model identity produce `MODEL_MISMATCH`. It reads captured settings, never the latest channel configuration. No active authorized run produces `WAITING`.

Matching enabled runs are counted across the single-stream worker scope. Multiple eligible runs produce unscoped `CAPACITY_EXCEEDED` reports only for affected channels; competing identifiers and counts are not public fields. If exactly one run is eligible, `ACTIVE` additionally requires that `AutomaticAiCycle` currently selects that run. Diagnostic discovery cannot grant dispatch permission.

The reader also inspects the latest committed inference outcome for the current run and exact worker model identity. A terminal model failure stays visible across worker restart and idle ticks until a successful result is committed or the run ends. `INPUT_TOO_LONG` is a per-message failure and is excluded from this health assessment; it does not prove the model is unavailable. Pipeline exceptions are mapped to allowlisted fault codes in memory and clear after a successful pipeline tick. A successful inference clears an in-memory inference fault. Private exception text is never persisted in reports.

`AiOperationalStatusCoordinator` runs in its own `WorkerRuntime` loop, independently of inference and action planning. State changes are written on the next status tick; unchanged reports renew heartbeat every 10 seconds, within the 30-second reporting lease. Competing claim attempts are also limited to once per 10 seconds. The scheduling clock is monotonic; persisted timestamps remain database-owned. Overlapping status ticks are ignored rather than queued.

Database or status-write failures are isolated from ingestion and moderation loops. When possible, a diagnostic-read failure produces an allowlisted `ERROR` report using the last known scope. During a database outage, writes may also fail: the last stored heartbeat ages out instead of being fabricated. After recovery, leases are reclaimed as needed and normal reports resume. Shutdown aborts reporting and waits for its pending database write before closing the pool. Reporting leases do not gate AI or provider dispatch.

When `AI_AUTOMATIC_ENABLED=false`, the running ingestion worker reports `WORKER_AI_DISABLED`; this specifically describes automatic mode, including when optional manual AI testing is enabled. When the worker itself is stopped or disabled, no heartbeat is published: existing reports expire and channels with no report remain unknown. Startup checks require migration 026 even if automatic AI is disabled. The worker role also needs SELECT on `youtube_channels`; refresh it with `npm run db:worker` after updating the code. Model artifacts and executor switches are unchanged.

The diagnostic reader currently scans connected channels on each runtime tick. This implementation targets the portfolio scope of one streamer/one eligible livestream and does not introduce production multitenant scheduling or workload guarantees.

## Step 4: authenticated status API

`GET /v1/channels/:channel_id/ai/status` requires a valid dashboard session and a current `OWNER` or `MODERATOR` membership. The global guards validate the channel UUID and session. The report query rechecks membership alongside its channel-scoped read. Operators and accounts without membership receive `403 CHANNEL_FORBIDDEN`; missing, expired, or revoked sessions receive `401`. Invalid channel identifiers receive `422`.

The response uses `aiOperationalStatusResponse`: `channel_id`, `availability`, `checked_at`, `stale_after_ms`, and `report`. With no report, availability is `UNKNOWN` and report is null. A heartbeat less than 30 seconds old is `ONLINE`; at 30 seconds or older it is `STALE`. Stale responses retain the last state for diagnosis, so a stale `ACTIVE` report must not be shown as currently active. Freshness uses the database clock, bounded below by the stored heartbeat if the database clock moves backward; it does not use the browser clock. Timestamps are serialized at millisecond precision.

The endpoint selects only public report fields and uses the API role's existing read-only permission. It does not expose reporting owner IDs, generations, lease expiry, model configuration, or raw errors. The API sends `Cache-Control: no-store`. This read performs no inference, provider request, heartbeat update, or moderation action and consumes no YouTube quota.

## Remaining implementation

1. Add a compact dashboard indicator with separate monitoring-end reasons, including quota exhaustion.
2. Verify dashboard rendering and status transitions in the final end-to-end flow.

## Validation

`npm run test:monitoring-http` verifies the status endpoint through real HTTP and the restricted API role in an isolated PostgreSQL schema. It covers all public states, unknown reports, stale active reports, channel isolation, current owner/moderator access, operator and missing-membership denial, UUID validation, session expiry/revocation, private-field omission, no-store responses, and denied API writes. Stale timestamps are simulated only in the isolated test schema.

`npm run test:ai-operational-status-contracts` covers status/reason consistency, run scope, timestamp ordering, public error restrictions, heartbeat expiry boundaries, unknown reports, and cross-channel envelope rejection. These are schema checks, not proof of authorization, persisted heartbeat behavior, or a running worker.

`npm run test:ai-operational-status-store` uses PostgreSQL in a random isolated schema with temporary worker/API roles. It checks atomic reports, stable state-change timestamps, concurrent claims/heartbeats, fenced restart takeover, scope substitution, direct SQL constraints, database-owned timestamps, read-only API permissions, and absence of live events. Expiry is simulated only within the isolated schema. The suite does not clear application data, load the model, or call YouTube.

`npm run test:ai-operational-status-coordinator` covers diagnostic states, cancellation, capacity projection, heartbeat throttling, lost claims, safe error mapping, and recovery. `test:automatic-ai-cycle`, `test:ai-shadow-coordinator`, and `test:worker-runtime` cover pipeline fault tracking, committed outcome propagation, reporting during inference, and shutdown draining. `test:automatic-ai-integration` now also verifies real diagnostic SQL and status writes using the restricted worker role, captured settings, capacity/membership changes, deferred inference heartbeat, persisted failure visibility after restart, and subsequent recovery. Its inference and provider adapters remain simulated; these tests consume no YouTube quota.
