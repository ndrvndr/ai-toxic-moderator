# AI operational status

## Step 1: shared contract

`aiOperationalStatus` describes automatic AI processing for one authorized channel. It is separate from ingestion state, per-message inference results, saved AI action decisions, and provider execution outcomes. This step adds schemas and tests only; the worker does not yet persist these reports, and no endpoint or dashboard indicator is added.

| State               | Reason                    | Meaning                                                                                                  | Run scope                                             |
| ------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `DISABLED`          | `WORKER_AI_DISABLED`      | Automatic AI is disabled in worker configuration.                                                        | None                                                  |
| `DISABLED`          | `RUN_AI_DISABLED`         | The run captured disabled AI settings.                                                                   | Required                                              |
| `WAITING`           | `NO_ELIGIBLE_RUN`         | No eligible active run is available.                                                                     | None                                                  |
| `ACTIVE`            | `RUN_SELECTED`            | An eligible run is selected for the pipeline. This does not promise successful inference or enforcement. | Required                                              |
| `MODEL_MISMATCH`    | `CAPTURED_MODEL_MISMATCH` | Captured model identity differs from the worker's available model identity.                              | Required                                              |
| `CAPACITY_EXCEEDED` | `MULTIPLE_ELIGIBLE_RUNS`  | The single-stream worker cannot select one of multiple eligible runs.                                    | None                                                  |
| `ERROR`             | `PROCESSING_FAILED`       | Discovery or processing failed; an allowlisted error code identifies the failure class.                  | Required when the failed run is known; otherwise none |

Channel scope is always required. Run and session IDs must either both be present or both be null. A schema cannot establish database ownership: the future store and endpoint must validate the run/session/channel relationship and current membership. Capacity reports must not expose identifiers or counts belonging to other channels.

`error_code` is null outside `ERROR`. Supported error codes are `MODEL_UNAVAILABLE`, `INFERENCE_FAILED`, `INFERENCE_TIMEOUT`, `INVALID_OUTPUT`, `DATABASE_UNAVAILABLE`, and `PIPELINE_FAILED`. Raw exceptions, stack traces, credentials, process IDs, and connection details are not public fields. Model mismatch is a configuration state, not a failed inference result.

## Heartbeat and API freshness

`updated_at` records the last state/scope/reason/error change. `heartbeat_at` records the worker's most recent liveness report and must not precede `updated_at`. Heartbeat writes need not create live-feed events or change the state-change timestamp.

`aiOperationalStatusResponse` wraps the report with the requested channel, `checked_at`, `stale_after_ms`, and availability:

| Availability | Meaning                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN`    | No report is available. `report` must be null; this does not prove that AI is disabled or the worker is stopped.                                                      |
| `ONLINE`     | A report exists and its heartbeat age is less than `stale_after_ms`.                                                                                                  |
| `STALE`      | Heartbeat age is at least `stale_after_ms`. The last report remains available for diagnosis, but its stored `ACTIVE` state must not be displayed as currently active. |

The API assesses freshness using a shared server/database time source. Browser time must not decide availability. `checked_at` cannot precede the heartbeat. The expiry interval must be an integer between 1 and 300000 milliseconds; this contract does not yet choose the runtime interval. Database read errors must follow the safe API error path, rather than masquerading as `UNKNOWN`.

Freshness is not inference progress. A live heartbeat can coexist with processing errors or an empty chat backlog. Likewise, a stale heartbeat does not establish that a provider request failed and must not trigger an automatic moderation retry.

## Remaining implementation

1. Add persistence and restricted database permissions for scoped reports, with heartbeat and state changes written atomically.
2. Connect automatic discovery and processing to status updates, distinguishing mismatch/disabled/capacity/error states and recovering from errors.
3. Add an authenticated channel-scoped status endpoint that assesses freshness and rechecks access.
4. Add a compact dashboard indicator with separate monitoring-end reasons, including quota exhaustion.
5. Verify transitions, stale heartbeat behavior, cross-channel access, recovery, and dashboard rendering.

## Validation

`npm run test:ai-operational-status-contracts` covers status/reason consistency, run scope, timestamp ordering, public error restrictions, heartbeat expiry boundaries, unknown reports, and cross-channel envelope rejection. These are schema checks, not proof of authorization, persisted heartbeat behavior, or a running worker.
