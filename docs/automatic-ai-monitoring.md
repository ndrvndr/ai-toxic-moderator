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

## Step 3: database integration coverage

`tests/automatic-ai-integration.test.cjs` runs the actual discovery SQL, inference-result writer, decision audit, plan materialization, live-event replay, and executor eligibility against PostgreSQL. It creates a random isolated schema, applies the existing migrations there, and provisions a temporary restricted worker role. Fixture setup uses the local test administrator; pipeline operations use the restricted role. Application tables and existing runtime roles are not cleared or rewritten.

The native runner and provider adapters are simulated. No model download, native inference, OAuth refresh, or YouTube request occurs. Covered scenarios include:

- Lifecycle filters, missing/disabled policies, exact model identity, current requester/credential memberships, closed sessions, and ended chat.
- Captured settings surviving channel edits; subsequent runs capturing disabled or changed policies while one runner remains alive.
- Persisted inference, audit, plans, and three ordered `chat.updated` events; repeated ticks and worker restart append no duplicate results, plans, or events.
- Late baseline classification, below-threshold scores, truncated inputs, terminal inference failures, blacklist priority, and explicit built-in priority.
- Loss of access during inference, two-stream capacity conflicts, and revocation of actual deletion/author eligibility.
- Rollback of an incomplete action bundle followed by recovery from committed inference/audit, and simulated executor dispatch through a committed claim with no retry of an uncertain author outcome.

The operator reported passing checks and continued after committing the integration step. The assistant has not executed these tests. This integration coverage does not prove real model accuracy or successful requests to YouTube.

Run the new suite manually after the preceding unit/build checks:

```powershell
npm run format
npm run check
npm run build:core
npm run test:automatic-ai-integration
```

`TEST_DATABASE_URL` must point to a local admin-capable test database that allows schema and role creation. The suite removes its own schema and role when it finishes. It does not require clearing your application database, enabling a worker, or starting a livestream.

## Browser verification procedure

After database tests pass, use a test livestream and viewer account to verify the real pipeline:

1. Stop any current monitoring run. Configure automatic mode as shown above, with the cached model revision matching Settings. Start API, dashboard, and worker. Keep the same worker process running through the remaining steps.
2. Save enabled AI Settings before clicking Start monitoring. Use the existing threshold configuration; proving discovery does not require lowering thresholds or sending a ban marker.
3. Start run A. Confirm `RUNNING` and the worker's automatic selection log. Send a unique message from the test viewer. Confirm model output and an AI decision appear in Live without refreshing. A below-threshold decision is a valid result; successful discovery does not require a moderation action.
4. Disable automatic AI in Settings while A is active. Send another unique message. A must retain its captured enabled settings and still produce AI output/decisions.
5. Stop A, then start run B without changing `.env` or restarting the worker. Send a new message. B captured disabled AI settings, so that new message must have no AI output/decision. Baseline classification and blacklist behavior remain independent. Historical results from A can still appear in the same session.
6. Stop B, save enabled AI Settings, and start run C. Send a new unique message. AI output/decisions must resume automatically, again without a run-ID edit or worker restart.
7. Open History and compare each message's original captured revision and result. In Network → WS, verify that `chat.updated` events advance the cursor and drive updates without a manual refresh.
8. Stop monitoring after verification. Record the run IDs, captured revisions, and the result of each check. Do not describe a selected AI tier or stored plans as confirmed provider execution.

If AI Settings or the worker model do not match, no run is selected. Verify the complete model identity before diagnosing the pipeline. If two eligible runs exist, stop the extra run and confirm automatic selection resumes.

## Operator browser results — 2026-10-04

The operator supplied the following Live chat results after following the automatic-mode A/B/C procedure. This is operator-reported browser evidence, not an independently executed assistant test.

| Check                                              | Message                     | Observed result                                                                                                       |
| -------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A captures enabled AI settings                     | `Halo pengujian otomatis A` | AI output and decision appeared. Safe rating (0/4), expected severity 0.1498; selected Timeout at threshold 0.1000.   |
| A retains its snapshot after Settings are disabled | `Halo snapshot A`           | AI output and decision still appeared. Safe rating (0/4), expected severity 0.1582; selected Ban at threshold 0.1500. |
| B captures disabled AI settings                    | `Halo pengujian otomatis B` | Baseline Allowed evaluation appeared without AI output or an AI decision.                                             |
| C captures enabled AI settings again               | `Halo pengujian otomatis C` | AI output and decision resumed. Safe rating (0/4), expected severity 0.1462; selected Timeout at threshold 0.1000.    |

All four messages received baseline Allowed evaluations. AI results identified model `laskar-ks/toxic-guardrail-minilm-id-en`, revision `0e011be8ba6aca297059e7ab1a07d4f11054e653`, INT8 variant, and adapter `laskar-shadow-1`.

The procedure keeps the same worker running without changing a manual run ID. The reported sequence is consistent with automatic discovery and immutable captured settings. The supplied chat output does not independently establish process continuity, absence of browser refreshes, WebSocket cursor advancement, or History behavior; those details were not supplied with these results. Run IDs and captured revision numbers were also not supplied.

Deletion and author executors were disabled for this procedure. AI-enabled messages showed stored plans and `Deletion pending`, with no confirmed provider outcome. This verifies inference, decision display, and planning behavior; it does not verify deletion, timeout, or ban execution in this test.

The low thresholds were functional test settings. Safe greetings selected Timeout or Ban because their expected severity exceeded those thresholds. These results are not evidence of toxicity accuracy, calibrated probabilities, or suitable moderation defaults. Threshold evaluation with safe, abusive, and ambiguous examples remains required before configuring the portfolio demo.

## Remaining verification

1. Evaluate conservative demo thresholds using safe, abusive, and ambiguous examples; document false positives and false negatives.
2. Confirm worker continuity, updates without refresh, History results, and WebSocket cursor behavior for the reported A/B/C sequence or a subsequent final E2E run.
3. Expose model mismatch/capacity/failure status in the dashboard and evaluate the limited portfolio workload, including restart recovery and action deduplication.

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
npm run test:automatic-ai-integration
npm run test:ai-shadow-cycle
npm run test:ai-action-decision-cycle
npm run test:ai-action-plan-cycle
npm run test:worker-runtime
npm run test:delete-execution-store
npm run build --workspace @moderator/worker
```

Reader/coordinator unit tests simulate database queries. The new integration suite and existing execution-store tests require `TEST_DATABASE_URL`; they use real PostgreSQL with simulated inference/provider responses. No listed test consumes YouTube quota or executes native inference. Database suite execution and automatic native/browser verification remain pending until the operator reports results.
