# Automatic AI monitoring for the portfolio MVP

## Scope

The target flow is Settings → Start monitoring → automatic AI processing using that run's captured settings, without editing a run ID in `.env` or restarting the worker for each new run. The portfolio scope supports one eligible livestream at a time. Model artifacts remain local and pinned; executor switches and existing dispatch provenance checks still apply.

## Step 1: discover eligible runs

`AutomaticAiRunReader` discovers a `RUNNING` YouTube run from the database using its immutable `monitoring_ai_settings_snapshots` record. It requires saved, enabled automatic AI settings and the exact model ID, revision, INT8 variant, and adapter identity supplied by the worker. It excludes stop requests, finished runs, closed sessions, ended chat, and credentials/requesters without current owner or moderator membership.

Discovery reads captured settings, not the channel's latest settings. It validates the returned snapshot and scope before returning a selection. Zero eligible runs returns `IDLE`; two eligible runs returns `CAPACITY_EXCEEDED` and selects neither. This is a single-stream capacity boundary, not support for processing multiple streams. Database errors propagate so the runtime can report and retry them; they are not interpreted as no active run.

The reader does not claim ingestion ownership, construct native inference, persist results, or authorize a provider request. Discovery is provisional: run state and access can change immediately afterward. Existing stores and executors must continue to validate scope and authorization at persistence and dispatch time.

## Step 2: connect the worker pipeline

`main.ts` now supports explicit automatic mode through `AI_AUTOMATIC_ENABLED`. `AutomaticAiCycle` occupies the runtime's disposable AI loop. It discovers the eligible run, executes inference, persists decision audits, and materializes plans serially. Discovery is repeated between stages and after materialization. A stopped run, lost membership, ended chat, or capacity conflict clears AI dispatch permission. A scope change stops the old pipeline's remaining stages; the next tick constructs cycles for the new run.

One lazily initialized `AiShadowRunner` is reused across successive runs. Only the run-scoped reader/audit/plan cycles change. No native child is created when discovery is idle. Overlapping ticks return `BUSY`, so the coordinator never creates an in-memory inference queue. An in-progress inference or database write finishes before another run's work starts.

Deletion and author eligibility stores receive the coordinator's current `allowedRunId()`. This is an additional gate, not authorization by itself: existing current run/access checks, captured settings, exact plan provenance, blacklist/built-in priority, dispatch claims, and executor switches still apply. Database or stage failures revoke selection and remain isolated from ingestion. The next tick retries discovery; persisted results and audits use existing idempotent recovery.

Shutdown immediately clears dispatch permission, disposes the shared runner, and drains the active tick before the runtime closes the database pool. Per-run cycles do not dispose the shared runner when switching scopes.

### Configure automatic mode

After installing/preparing the local model artifacts and provisioning the existing worker role, configure:

```dotenv
AI_AUTOMATIC_ENABLED=true
AI_SHADOW_ENABLED=false
AI_SHADOW_RUN_ID=
AI_SHADOW_MODEL_REVISION=0e011be8ba6aca297059e7ab1a07d4f11054e653
```

Use the revision from your actual cached manifest. The example revision must also match the model identity saved in Settings. Keep `WORKER_ENABLED=true` and Google authentication configured. Enable `YOUTUBE_DELETE_ENABLED` for deletion and `YOUTUBE_BAN_ENABLED` for timeout/ban only when intending real moderation.

Restart the worker once to activate this mode. Save enabled AI Settings before starting monitoring; the worker then discovers matching `RUNNING` runs without further run-ID edits or restarts. Settings edits still apply to new runs only. Automatic mode does not infer for disabled/default/legacy snapshots or stopped historical runs. It does not change the existing built-in/blacklist processing.

Manual mode remains available with `AI_AUTOMATIC_ENABLED=false`, `AI_SHADOW_ENABLED=true`, and an explicit run ID. Configuration rejects enabling both modes or retaining a manual run ID in automatic mode. No migration, role change, or new model download is required for this integration.

## Remaining integration

1. Verify discovery SQL and the complete automatic pipeline against a real local database with isolated fixtures, including current membership changes and captured settings.
2. Verify real browser behavior across stop/start without run-ID edits or worker restarts.
3. Expose model mismatch/capacity/failure status in the dashboard and evaluate the limited portfolio workload.

Capacity and selection changes currently produce worker log messages. A model mismatch is excluded from discovery and can appear as waiting for an eligible run; it is not yet a distinct dashboard status. Public deployment, multi-stream scheduling, and model calibration are separate work.

## Manual validation

Run these commands yourself; the assistant has not executed them:

```powershell
npm run format
npm run check
npm run build:core
npm test
npm run test:automatic-ai-run-reader
npm run test:automatic-ai-cycle
npm run test:ai-shadow-cycle
npm run test:ai-action-decision-cycle
npm run test:ai-action-plan-cycle
npm run test:worker-runtime
npm run test:delete-execution-store
npm run build --workspace @moderator/worker
```

The new reader/coordinator tests use simulated query results and runners and consume no YouTube quota or native inference. They cover configuration, run discovery, serial stage ordering, selection changes, capacity, snapshot/model rejection, cancellation, failure recovery, and shutdown. Existing execution-store tests additionally require `TEST_DATABASE_URL`. These checks do not establish that the discovery SQL works against a real database or that automatic native inference succeeds; those verifications remain pending.
