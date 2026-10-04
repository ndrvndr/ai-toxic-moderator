# AI moderation thresholds

## Implementation status

Steps 1–9 define shared settings contracts, immutable revisions and run snapshots, authorized settings controls, the threshold planner, decision audits, executor integration, and public decision summaries in Live and History chat. The selected AI run can materialize persisted action slots and dispatch them through existing executors when its captured settings and worker action switches enable enforcement. Manual mode uses one configured run ID. The new [automatic monitoring mode](automatic-ai-monitoring.md) discovers one eligible active run from captured enabled Settings and follows subsequent runs without run-ID edits; database and browser verification of that integration remain pending.

Step 10 real-provider DELETE, TIMEOUT, and BAN scenarios were reported successful by the developer on October 4, 2026 (Asia/Jakarta). See [real-provider verification](#real-provider-verification) for evidence and limitations. The assistant did not independently execute these scenarios.

The new contracts live in `packages/contracts/src/ai-moderation-settings.ts`. They are separate from built-in rule settings and custom blacklist revisions.

## Configuration contract

Every configuration requires:

- `schema_version: 1` and an explicit `automatic_actions_enabled` boolean.
- `model`: exact `model_id`, 40-character hexadecimal `model_revision`, `model_variant: "INT8"`, and `adapter_version`.
- `score_metric: "EXPECTED_SEVERITY"`, corresponding to the model's `severity_score` in the range 0–1. This is not the probability of a policy violation and is not the discrete model rating.
- `delete`, `timeout`, and `ban`: an explicit `enabled` boolean and numeric `threshold` for each tier.
- `timeout.duration_seconds`: an integer from 1 to 86,400, matching the existing application configuration bounds.

Thresholds must satisfy `delete < timeout < ban`, including when enforcement or individual tiers are disabled. Equal thresholds, crossed thresholds, numeric strings, non-finite numbers, and unknown fields are rejected. The endpoints 0 and 1 are valid if ordering is preserved.

No fields silently enable enforcement or supply calibrated threshold defaults. Initial settings should have enforcement disabled and AI ban disabled. An explicit configuration may enable individual tiers independently.

The update contract requires `expected_revision`: zero for the first write, or the revision last read for later writes. Clients cannot provide channel ownership or record metadata. The record contract requires server-assigned identity, channel, author, creation time, and a positive revision. Responses represent missing settings as `{ "settings": null }`.

## Decision flow

The worker persists threshold decisions before materializing action slots for the selected AI run:

1. Check the captured custom blacklist first. A match uses the blacklist's action bundle and skips AI.
2. For other messages, evaluate AI using the exact model identity and settings captured when the monitoring run starts.
3. If automatic actions are enabled, select the highest enabled tier whose threshold is met (`severity_score >= threshold`). Disabled tiers do not participate.
4. A delete tier produces `DELETE`. A timeout tier produces `DELETE` plus `TIMEOUT`. A ban tier produces `DELETE` plus `BAN`. Disabling the delete tier disables delete-only selection; author-action bundles still include message deletion.
5. If no enabled threshold is met, AI produces no action. Missing settings, inference failures, truncated input, and mismatched model identities must also produce no AI action.
6. Persist the decision and its provenance before execution. Replay must reuse the stored decision, and settings edits must affect only new monitoring runs.

Built-in rules and blacklist handling remain independent of AI availability. A captured blacklist match skips AI. If an actionable built-in plan already exists for the same observation, it takes priority over the entire AI bundle. A built-in `NONE` plan does not suppress AI. This deliberately preserves explicit rule choices rather than escalating an existing timeout into an AI ban. Audit data still records the model decision even when execution is suppressed.

## Calibration and verification

The prototype showed overlapping scores for safe and abusive examples. Contract validation establishes valid configuration structure, not model accuracy or safe enforcement thresholds. Automatic AI ban stays disabled in initial settings; enabling it requires an explicit setting and separate verification.

Run the checks manually, using a local admin-capable `TEST_DATABASE_URL` for persistence tests:

```powershell
npm run format
npm run check
npm run build:core
npm run build --workspace @moderator/api
npm run db:migrate
npm run db:runtime
npm run db:worker
npm run test:ai-moderation-contracts
npm run test:ai-moderation-settings-store
npm run test:ai-moderation-settings-http
npm run test:ai-shadow-contracts
npm run test:moderation-settings-contracts
npm run test:custom-blacklist-store
npm run test:custom-blacklist-http
npm run test:monitoring-start
npm run test:live-hooks
npm run build --workspace @moderator/dashboard
```

These tests require neither a livestream nor YouTube quota. Migration `024_ai_moderation_settings.sql` adds the new tables and triggers. Apply migrations before reprovisioning API and worker permissions. Persistence tests use temporary schemas and roles and clean them up afterward.

## Persistence and snapshots

`channel_ai_moderation_settings` stores consecutive immutable revisions per channel. `AiModerationSettingsStore` validates inputs, normalizes UUIDs, takes a per-channel transaction lock, rechecks the caller's authorization callback, and compares `expected_revision` before inserting. Conflicting writes return `AiModerationSettingsConflict` with the current revision. The settings service authorizes reads and maps write conflicts to the public error contract.

An insert trigger captures the latest committed settings visible during run creation in `monitoring_ai_settings_snapshots`. It runs in the same transaction as `monitoring_runs`, so a failed run creation also rolls back its snapshot. Existing runs keep their captured revision after settings edits. Capture does not wait for an uncommitted newer revision or take the settings writer's advisory lock.

Snapshots have explicit provenance:

- `SAVED`: exact settings ID, revision, and configuration from the same channel.
- `DEFAULT`: no saved settings at capture time; ID, revision, and configuration are null.
- `LEGACY`: migration backfill for historical runs; ID, revision, and configuration are null. Application inserts cannot claim this source.

Null configuration means no AI enforcement policy. It does not imply a particular model or threshold. Database constraints validate configuration shape, score ordering, revision references, and channel relationships. Triggers prevent updates and deletes to historical settings and snapshots.

The API role can select and insert revisions and snapshots, as required by run creation. The worker can select captured snapshots only; it cannot read current channel AI settings or write either table. Its audit loop uses these snapshots when saving decisions for the configured shadow run.

## Settings endpoints

Both endpoints require a valid dashboard session and channel membership:

| Method | Route                                             | Access             | Result                                                          |
| ------ | ------------------------------------------------- | ------------------ | --------------------------------------------------------------- |
| GET    | `/v1/channels/:channel_id/ai-moderation-settings` | Owner or moderator | `200` with `{ "settings": null }` or the latest settings record |
| POST   | `/v1/channels/:channel_id/ai-moderation-settings` | Owner only         | `200` with the newly saved settings record                      |

POST requires the configured dashboard Origin and a JSON body containing only `expected_revision` and `configuration`. Use zero when GET returns null; otherwise use the revision returned by GET. The configuration must include the explicit model identity, score metric, switches, ordered thresholds, and timeout duration described above. Enabled settings can authorize AI actions only for new runs that capture them, with explicitly configured AI processing and enabled executor switches.

Responses use `Cache-Control: no-store`. Errors carry a trace ID and safe field paths/codes, without echoing model input or database details:

| Status | Code                            | Meaning                                                            |
| ------ | ------------------------------- | ------------------------------------------------------------------ |
| 401    | `UNAUTHENTICATED`               | Missing, expired, or revoked session                               |
| 403    | `CHANNEL_FORBIDDEN`             | No owner/moderator access to the requested channel                 |
| 403    | `AI_SETTINGS_WRITE_FORBIDDEN`   | A moderator attempted to change settings                           |
| 403    | `ORIGIN_FORBIDDEN`              | Missing or untrusted Origin on a mutation                          |
| 422    | `VALIDATION_ERROR`              | Invalid channel ID or settings body                                |
| 409    | `AI_SETTINGS_REVISION_CONFLICT` | Settings changed since the supplied revision; reload before saving |
| 413    | `PAYLOAD_TOO_LARGE`             | JSON body exceeds the existing 16 KiB API limit                    |
| 400    | `BAD_REQUEST`                   | Malformed JSON                                                     |

Authorization is checked before settings validation or revision conflict handling, and is checked again inside the write transaction after the channel revision lock is acquired. Operators and owners of unrelated channels cannot read or change the settings. A conflict never rewrites an existing revision or automatically retries an edit.

HTTP tests run the built NestJS API against temporary local database schemas with the provisioned API role. Build both core packages and the API before running them. They exercise access, validation, safe errors, immutable revisions, and competing writes without contacting YouTube.

## Dashboard settings

Open `/settings/moderation`, select an accessible channel, and use **AI moderation thresholds** below the custom blacklist. Owners can edit; moderators see disabled controls without a save button. The section explains that settings apply to new runs and require AI processing and worker action switches before enforcement.

The form provides a global AI action switch, independent delete/timeout/ban switches, thresholds in the range 0–1, and timeout duration. New forms start with every switch disabled and thresholds blank. The staged timeout duration starts at 30 seconds; it is not a calibrated AI threshold. No revision exists until a valid configuration is explicitly saved.

Expand **Model identity** to enter the exact model ID, revision, and adapter version. For the current local prototype, read `modelId` and `revision` from `.cache/ai-prototype/manifest.json`. Use the adapter version recorded by the worker; the current Laskar adapter exports `laskar-shadow-1`. The variant is INT8. Saved model fields are retained when editing thresholds. Changing the model identity requires reviewing threshold behavior again.

Every tier still needs a valid threshold while disabled, and the timeout duration is required while its tier is disabled. This preserves a valid staged configuration. Client validation rejects empty numeric fields instead of interpreting them as zero, and uses the same shared contract as the API.

TanStack Query handles reads and mutations using keys scoped to account and channel. Switching either identity resets the local form draft. Save submits the last explicitly loaded revision and updates only that channel's cache after a verified response. A background read does not silently replace an unsaved draft.

On a conflict or uncertain save result, the form retains the draft and blocks further writes. **Reload AI settings and discard changes** explicitly loads the latest revision and resets the draft. A transient reload failure retains the draft; an access failure hides the form, clears its cached settings, and refreshes account access information. Mutations are not automatically retried.

Component tests cover initial disabled state, validation, revision handling, pending submission protection, conflict recovery, read-only access, cache clearing, identity changes, and rejection of mismatched API responses. Run `npm run test:live-hooks` to include them in the existing dashboard suite.

For manual browser verification, keep the worker stopped and check that settings can be saved, survive page reload, reject equal thresholds, and display the updated revision. This step requires no active broadcast or YouTube quota.

## Pure threshold planner

`AiActionPlanner` in `packages/moderation-core/src/ai-action-planner.ts` accepts an immutable run settings snapshot. Its `plan(input, output, blacklist)` method requires message scope (including observation and classification IDs), a full scoped AI result or missing output, and the blacklist action bundle already computed for that message. A missing or invalid blacklist decision is rejected; AI cannot bypass that prerequisite. A blacklist match produces `BLACKLIST_MATCH` with no AI plans, leaving the independent blacklist bundle in control.

Snapshot run/channel, blacklist run/channel/session/classification, and valid model output run/channel/session/observation must match the message scope. Substitution throws before generating plans. UUID comparisons normalize casing while opaque message and author targets retain their exact values. Matched blacklist plans must also target the same message and author.

The planner compares `severity_score`, not `rating`, against the captured thresholds. Selection includes equality and ignores disabled tiers. Missing policy, disabled enforcement, missing/malformed output, mismatched identity, inference errors, and truncation produce explicit no-action reason codes. If a selected author action has no valid YouTube channel target, deletion remains planned and `author_action_status` is `TARGET_UNAVAILABLE`.

The returned in-memory decision carries a separate copy of captured settings, validated model output when considered, planner version, selected tier/threshold, reason code, and independent message/author plans. It is not an execution outcome or dispatch authorization. Policy slots are deterministic per run; replaying identical inputs produces identical decisions. The planner performs no database, network, model inference, or provider calls.

Run these additional checks manually:

```powershell
npm run format
npm run check
npm run build:core
npm run test:ai-action-planner
npm run test:blacklist-action-planner
npm run test:ai-moderation-contracts
```

Planner tests cover boundaries, every tier switch combination, blacklist priority, scope and identity substitution, unavailable output/targets, independent action slots, and immutable replay. These planner checks require no database or YouTube quota.

## Immutable decision persistence

Migration `025_youtube_ai_action_decisions.sql` adds `youtube_ai_action_decisions`, with one immutable decision per run and observation. Each row references the original classification and optional persisted model result. It contains the decision, captured settings, scoped model output when considered, and the recomputed blacklist audit. No historical decisions are backfilled and no existing classifications are rewritten.

`AiActionDecisionStore.save(client, input)` requires a caller-owned transaction and only accepts run/channel/session/observation/classification IDs plus an explicit nullable `model_result_id`. It does not accept caller-provided targets, scores, snapshots, or decisions. It derives targets and text from the observation, loads both captured snapshots, recomputes the blacklist match, reads the referenced stored model result, and invokes the planner. Inference and provider calls do not run inside this transaction.

An advisory transaction lock serializes writers for the same run and observation. The first saved decision wins; later saves return that row with `reused: true`, retaining the original model reference even if another reference is supplied. A different classification cannot replace the original decision. `find(client, scope)` reads and validates the stored audit without resolving a newer model output or running the planner again.

Saving missing output creates a terminal no-action audit. A late model result cannot change it. Worker integration must therefore wait until inference finishes or reaches a terminal failure before saving, rather than treating an in-progress inference as missing output. Missing, disabled, mismatched, failed, truncated, and blacklist-priority cases retain explicit reason codes.

Database guards check classification/observation/run/model scope, captured snapshot equality, observed targets, threshold selection, independent plan slots, and the exact decision payload. Updates and deletes are rejected. The store recomputes literal blacklist matches from captured configuration; SQL metadata validation alone is not proof of a text match or authorization to dispatch.

The decision store saves embedded audit data and appends one transactional `chat.updated` event for a new audit. Replay does not append another event. Step 8 adds a separate materialization cycle that inserts executor-visible plans from this immutable audit. The worker role has SELECT/INSERT on the audit table; the API role has SELECT only. Neither role can update, delete, or truncate it. The separate cycle requires no new table or migration and does not rewrite the audit.

Run these checks manually, using an admin-capable local `TEST_DATABASE_URL` for the isolated database suite:

```powershell
npm run format
npm run check
npm run build:core
npm run build --workspace @moderator/worker
npm run db:migrate
npm run db:runtime
npm run db:worker
npm run test:ai-action-decision-store
npm run test:ai-action-planner
npm run test:ai-moderation-settings-store
npm run test:blacklist-action-store
```

Apply the new migration before reprovisioning runtime permissions. Tests create and clean up temporary schemas/roles and exercise concurrent saves, immutable replay, scope substitution, malformed audit rejection, transaction rollback, database guards, restricted permissions, and absence of queued actions. No livestream, model inference, or YouTube quota is required.

## Worker audit pipeline

In manual mode, `AiActionDecisionCycle` runs alongside ingestion and shadow inference through `AI_SHADOW_ENABLED`, processing only `AI_SHADOW_RUN_ID`. In automatic mode, `AutomaticAiCycle` invokes a run-scoped decision cycle after inference for the discovered eligible run. Both modes use the same pinned runtime model revision and adapter identity. Automatic mode supports one eligible stream and a matching local model, not arbitrary model loading or multi-stream scheduling.

`AiActionDecisionCandidateReader` reads text observations from the selected run that have an original baseline classification and no saved AI decision. If several classifications exist for the observation, it selects the earliest by creation time and ID. It validates captured AI and blacklist snapshots, recomputes blacklist matching, and looks for a committed terminal shadow result with the exact configured runtime model identity. Both successful and error results are terminal.

An enabled AI policy without a blacklist match waits until a terminal result exists. Pending inference is skipped rather than persisted as `OUTPUT_MISSING`; keyset scanning continues to later messages so pending rows do not starve completed results. Blacklist matches, missing policy, and globally disabled enforcement can produce their no-action audit without waiting for inference. Invalid or missing snapshots fail closed before persistence. Non-text and blank inputs are not audited.

Selection occurs outside the persistence transaction. The cycle then uses `AiActionDecisionStore` to re-read authoritative targets, policy, blacklist, and model output inside a short transaction. An inference result committed before a crash remains selectable after restart, including when its classification becomes available later. Completed audits are excluded from selection; racing cycles reuse the first committed audit through the store's lock and immutable replay.

The audit cycle uses the runtime's existing shutdown signal and failure isolation. Cancellation before persistence prevents the save; writes already in progress are drained before the pool closes. A failed audit cycle logs a safe error and can retry on a later tick without stopping ingestion. Shadow inference retains its own cancellation and disposal lifecycle.

Startup checks for enabled AI mode verify the decision table and captured AI snapshot table. Manual mode logs **AI inference and action planning are enabled for the configured run. Dispatch requires captured enabled settings and executor switches.** Automatic mode logs its single-stream discovery status separately. Apply migration 025 and provision worker permissions before starting AI processing. Manual audit backlog processing can include a stopped run; automatic discovery, materialization, and dispatch require a running original run.

Run the checks manually:

```powershell
npm run format
npm run check
npm run build:core
npm run build --workspace @moderator/worker
npm run test:ai-action-decision-cycle
npm run test:ai-action-decision-store
npm run test:worker-runtime
npm run test:ai-shadow-cycle
npm run test:ai-shadow-coordinator
```

Cycle tests exercise pending inference, policy skips, snapshot scope checks, cursor precision, cancellation, transaction ordering, retries, and replay. Database integration tests additionally verify committed-result recovery, late classifications, terminal errors, and absence of queued actions from the audit store itself. They use isolated fixtures and do not run native inference or YouTube requests.

## Executor integration

In manual mode, `AiActionPlanCycle` runs independently alongside the audit loop for `AI_SHADOW_RUN_ID` when `AI_SHADOW_ENABLED` is enabled. Automatic mode invokes the same scoped cycle serially after audit processing for the discovered run. It selects committed `THRESHOLD_MET` decisions on a `RUNNING` original run whose action slots are missing. It recovers a crash between audit persistence and materialization without rerunning inference. A selected decision without an available author can still materialize deletion alone.

`AiActionPlanStore` re-reads authoritative observations, captured AI and blacklist snapshots, and the referenced stored model result. It recomputes both planners and compares the complete decision with the immutable audit. A short caller-owned transaction, an audit advisory lock, deterministic policy slots, and the existing action-plan uniqueness constraint serialize competing workers. Message and author slots commit together. If either fails, a savepoint removes all new slots even when the caller catches the failure. Replay returns existing plan IDs; it does not replan using current settings.

All `ai-` policy names are reserved. Candidate discovery and executor eligibility require a linked scoped audit and captured enabled policy, successful untruncated inference, matching action metadata, and no competing built-in/blacklist action for the observation. `AiDispatchProvenance` additionally reconstructs the full evidence and compares the exact selected plan before dispatch. A policy name, a high score, or an inserted plan alone cannot authorize an AI request. Foreign runs/sessions, malformed evidence, forged action reasons, and missing model references fail closed.

Existing authorization checks still apply: active original run, open YouTube session and chat, current owner/moderator memberships, credential scope, and the corresponding `YOUTUBE_DELETE_ENABLED` or `YOUTUBE_BAN_ENABLED` switch. AI dispatch additionally requires an initialized AI pipeline and that the plan belongs to the manually configured or automatically selected run. Existing controlled test policy restrictions still apply. Disabling the applicable AI mode and restarting the worker blocks pending AI dispatch without preventing built-in actions.

The existing executors continue to commit a dispatch claim before contacting YouTube and recheck eligibility after credential refresh and claim creation. Per-message deletion deduplication, per-observation author execution, timeout spacing, and conservative `UNKNOWN` handling are reused. No automatic author retry is added. Plans are not replaced or escalated after another execution has started. Execution events update chat over WebSocket; step 9 also displays the saved AI decision and planning state.

Enabled captured settings can now cause real moderation requests when the configured run is active and executor switches are enabled. Keep `automatic_actions_enabled` disabled when evaluating scores without enforcement. Disabling or editing channel settings affects new runs; the runtime action switches remain the way to stop execution for an existing captured run.

Run these checks manually:

```powershell
npm run format
npm run check
npm run build:core
npm run build --workspace @moderator/worker
npm run test:ai-action-plan-cycle
npm run test:ai-action-decision-store
npm run test:ai-action-decision-cycle
npm run test:worker-runtime
npm run test:delete-execution-store
npm run test:blacklist-action-store
npm run test:live-hooks
```

The database suites require a local admin-capable `TEST_DATABASE_URL` and use isolated schemas and restricted worker roles. Added checks cover concurrent materialization, rollback of both slots, replay after restart, built-in priority, reserved policy rejection, current access and run scope, committed claims, and non-redispatch of uncertain author attempts. Provider responses are simulated; these checks consume no YouTube quota.

## Public AI decision summaries

The authorized chat endpoint exposes optional nullable `ai_decision` on each text observation. An absent audit returns `null`; it does not imply pending inference, an allowed message, or a selected action. Existing baseline evaluations and outcome/category filters remain independent of AI decisions. Live and History use the same chat message component.

The summary includes the immutable reason code, selected tier and threshold, captured settings revision and model identity, considered model identity and severity score, requested timeout duration when applicable, author planning status, and decision timestamp. It refers to the original observation's run and stored audit, even after settings edits or a later model result. The separate model output panel can show a newer result. The public response omits full settings, action plan payloads, internal audit/result/classification IDs, raw provider payloads, and credentials.

Planning state is read from the same database snapshot as chat:

- `NOT_SELECTED`: the audit selected no AI action; its reason explains the skip.
- `BUILT_IN_PRIORITY`: an actionable built-in or blacklist plan for this observation takes priority. The API and worker share the same arbitration SQL.
- `AWAITING_PLANS`: the original run is active but some selected action slots are missing.
- `PLANS_CREATED`: all selected action slots are stored. This is not a provider confirmation or proof that dispatch is currently authorized.
- `RUN_INACTIVE`: some selected slots are missing and the original run is inactive.

Deletion and author execution panels remain the source of provider outcomes. A saved AI timeout or ban tier does not establish the author's current YouTube restriction. `TARGET_UNAVAILABLE` explains that only deletion was planned when the author target could not be identified. Severity remains a model score, not a probability of a policy violation.

New audit insertion emits one `chat.updated` event. Materializing any new slots in a bundle emits one additional event after all slots are saved. Both events commit with their resource changes; savepoint failure or caller rollback removes the new event and its cursor increment. Replaying either operation appends nothing. Existing WebSocket refresh handling updates the shared chat cache without a new event type or client protocol.

Run these checks manually; no migration or new environment variable is needed for this step:

```powershell
npm run format
npm run check
npm run build:core
npm run build --workspace @moderator/api
npm run build --workspace @moderator/worker
npm run test:chat-ai-decision
npm run test:ai-action-decision-store
npm run test:monitoring-http
npm run test:live-hooks
npm run test:ai-action-plan-cycle
npm run build --workspace @moderator/dashboard
```

The contract and component tests require no model downloads or YouTube quota. Database and HTTP tests use isolated local fixtures with simulated model results. They cover provenance scope, current authorization, immutable evidence after model/settings changes, baseline filters, planning versus execution, transactional event replay, and rollback. They do not establish real model accuracy or successful moderation on YouTube.

For browser verification, select the configured AI run and a new text message. Confirm that its AI decision panel appears without refreshing, identifies the captured settings and considered score, and shows the selected tier or explicit skip reason. Check that later action outcomes appear separately. Open the saved session in History and compare the same evidence. Existing messages without an audit should have no AI decision panel.

## Real-provider verification

On October 4, 2026 (Asia/Jakarta), the developer reported that the local livestream AI enforcement scenarios passed. These are operator-reported browser and YouTube results, supplemented by pasted dashboard output. They are separate from automated tests with simulated provider responses; the assistant did not run the worker, browser checks, or terminal commands.

The procedure isolated AI decisions by disabling custom blacklist matches and built-in automatic actions, clearing controlled marker scopes, and saving the exact cached model identity before starting each new monitoring run:

- Model: `laskar-ks/toxic-guardrail-minilm-id-en`.
- Revision: `0e011be8ba6aca297059e7ab1a07d4f11054e653`.
- Variant: `INT8`; adapter: `laskar-shadow-1`.

Each settings change used a new run snapshot. Inference and planning were enabled for that run through `AI_SHADOW_ENABLED` and `AI_SHADOW_RUN_ID`.

| Scenario | Captured enabled thresholds                            | Reported result                                                                                                                          |
| -------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| DELETE   | Delete 0.10; timeout and ban disabled                  | AI selected DELETE; YouTube deletion was confirmed.                                                                                      |
| TIMEOUT  | Delete 0.05; timeout 0.10 for 30 seconds; ban disabled | AI selected TIMEOUT with a deletion plan; the developer confirmed that the viewer could be timed out after enabling the author executor. |
| BAN      | Delete 0.05; timeout 0.10 for 30 seconds; ban 0.15     | The developer reported the BAN scenario and its owner-side restriction checks passed.                                                    |

The DELETE output supplied for `Halo, terima kasih sudah streaming!` showed baseline `ALLOW`, model rating `Safe` (0/4), expected severity `0.1685`, selected tier DELETE with captured threshold `0.1000`, stored plans, and a separate `Deleted` provider result. This demonstrates that threshold selection uses expected severity rather than the baseline rule outcome or discrete model label.

The initial TIMEOUT check produced deletion alone while `YOUTUBE_BAN_ENABLED` was disabled. Enabling that switch and restarting the worker preceded the developer's report that timeout worked. `YOUTUBE_DELETE_ENABLED` gates deletion; `YOUTUBE_BAN_ENABLED` gates both timeout and permanent ban execution. Captured settings determine which author tier is selected.

The developer reported the prescribed Live and History checks passed, including action updates without a manual refresh. Complete provider payloads, execution IDs, and owner-side timing records were not supplied for the final timeout and ban checks. The pasted planning output alone is not proof of either provider execution.

### Scope and cleanup

The thresholds above were deliberately low test values, not recommended defaults or calibrated production thresholds. Restricting a safe greeting verifies the enforcement path; it does not demonstrate accurate toxicity detection. The prototype evaluation already shows overlapping scores for safe and abusive examples.

The reported verification used one explicitly configured run at a time. It does not establish the newer automatic discovery flow, behavior under high chat volume, or production readiness. Conservative `UNKNOWN` handling, repeated-timeout scheduling, and the external-unban limitation still apply.

After the test, stop monitoring and the worker, disable automatic AI actions before starting unrelated streams, and remove the test viewer from Hidden users if needed. These cleanup steps were instructed; their final completion was not separately confirmed in the report. Editing channel settings affects future snapshots; stop the existing run or disable executor switches to prevent further dispatch under its captured settings.
