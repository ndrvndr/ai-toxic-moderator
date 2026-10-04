# Automatic AI monitoring for the portfolio MVP

## Scope

The target flow is Settings → Start monitoring → automatic AI processing using that run's captured settings, without editing a run ID in `.env` or restarting the worker for each new run. The portfolio scope supports one eligible livestream at a time. Model artifacts remain local and pinned; executor switches and existing dispatch provenance checks still apply.

## Step 1: discover eligible runs

`AutomaticAiRunReader` discovers a `RUNNING` YouTube run from the database using its immutable `monitoring_ai_settings_snapshots` record. It requires saved, enabled automatic AI settings and the exact model ID, revision, INT8 variant, and adapter identity supplied by the worker. It excludes stop requests, finished runs, closed sessions, ended chat, and credentials/requesters without current owner or moderator membership.

Discovery reads captured settings, not the channel's latest settings. It validates the returned snapshot and scope before returning a selection. Zero eligible runs returns `IDLE`; two eligible runs returns `CAPACITY_EXCEEDED` and selects neither. This is a single-stream capacity boundary, not support for processing multiple streams. Database errors propagate so the runtime can report and retry them; they are not interpreted as no active run.

The reader does not claim ingestion ownership, construct native inference, persist results, or authorize a provider request. Discovery is provisional: run state and access can change immediately afterward. Existing stores and executors must continue to validate scope and authorization at persistence and dispatch time.

**This step is not yet connected to `main.ts`.** The current worker still requires `AI_SHADOW_RUN_ID`. Do not remove that setting yet. No migration or environment change is required for this step.

## Remaining integration

1. Add a coordinator that uses discovery, shares one inference runner, changes the selected run after stop/restart, and drains work on shutdown.
2. Connect inference, decision audits, action materialization, and dispatch permission to the selected run. Add an explicit automatic mode while preserving manual shadow verification.
3. Verify settings capture, cancellation, database failure recovery, capacity handling, and real browser behavior without run-ID edits.

Model mismatch and capacity limits need visible operator status before calling the complete automatic flow verified. Public deployment, multi-stream scheduling, and model calibration are separate work.

## Manual validation

Run these commands yourself; the assistant has not executed them:

```powershell
npm run format
npm run check
npm run test:automatic-ai-run-reader
npm run build --workspace @moderator/worker
```

The reader tests use simulated query results and consume no YouTube quota or native inference. They cover run discovery, selection changes, capacity, snapshot/model rejection, cancellation, and retry after a database failure. They do not establish that the SQL filters work against a real database; add database integration coverage when wiring the reader into the worker.
