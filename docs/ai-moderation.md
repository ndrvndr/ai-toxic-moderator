# AI moderation thresholds

## Implementation status

Steps 1–5 define shared settings contracts, validation, immutable database revisions, atomic run snapshots, role permissions, authorized settings endpoints, dashboard controls, and a pure AI threshold planner. The planner is not connected to the worker or executors yet. Existing AI output remains shadow output and does not change moderation decisions.

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

## Planned decision flow

The pure planner implements threshold selection below. Persistence and runtime dispatch of its decisions remain planned:

1. Check the captured custom blacklist first. A match uses the blacklist's action bundle and skips AI.
2. For other messages, evaluate AI using the exact model identity and settings captured when the monitoring run starts.
3. If automatic actions are enabled, select the highest enabled tier whose threshold is met (`severity_score >= threshold`). Disabled tiers do not participate.
4. A delete tier produces `DELETE`. A timeout tier produces `DELETE` plus `TIMEOUT`. A ban tier produces `DELETE` plus `BAN`. Disabling the delete tier disables delete-only selection; author-action bundles still include message deletion.
5. If no enabled threshold is met, AI produces no action. Missing settings, inference failures, truncated input, and mismatched model identities must also produce no AI action.
6. Persist the decision and its provenance before execution. Replay must reuse the stored decision, and settings edits must affect only new monitoring runs.

Built-in rules and blacklist handling remain independent of AI availability. The later planner must define how their actions combine with AI decisions without duplicating message or author execution.

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

The API role can select and insert revisions and snapshots, as required by run creation. The worker can select captured snapshots only; it cannot read current channel AI settings or write either table. Runtime AI policy consumption is deferred to the worker integration step.

## Settings endpoints

Both endpoints require a valid dashboard session and channel membership:

| Method | Route                                             | Access             | Result                                                          |
| ------ | ------------------------------------------------- | ------------------ | --------------------------------------------------------------- |
| GET    | `/v1/channels/:channel_id/ai-moderation-settings` | Owner or moderator | `200` with `{ "settings": null }` or the latest settings record |
| POST   | `/v1/channels/:channel_id/ai-moderation-settings` | Owner only         | `200` with the newly saved settings record                      |

POST requires the configured dashboard Origin and a JSON body containing only `expected_revision` and `configuration`. Use zero when GET returns null; otherwise use the revision returned by GET. The configuration must include the explicit model identity, score metric, switches, ordered thresholds, and timeout duration described above. Persisting enabled settings does not activate AI actions while worker integration remains unfinished.

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

Open `/settings/moderation`, select an accessible channel, and use **AI moderation thresholds** below the custom blacklist. Owners can edit; moderators see disabled controls without a save button. The section explicitly states that saved thresholds do not activate AI actions yet.

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

Planner tests cover boundaries, every tier switch combination, blacklist priority, scope and identity substitution, unavailable output/targets, independent action slots, and immutable replay. These checks require no database or YouTube quota. Step 6 will add validated persistence and replay of AI decisions. Worker consumption, executor integration, and arbitration with built-in rule actions remain later steps.
