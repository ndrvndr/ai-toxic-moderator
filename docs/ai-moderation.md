# AI moderation thresholds

## Implementation status

Steps 1–2 define shared settings contracts, validation, immutable database revisions, atomic run snapshots, role permissions, and persistence tests. Settings endpoints, dashboard controls, and AI action dispatch are not implemented yet. Existing AI output remains shadow output and does not change moderation decisions.

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

The following behavior is planned; this contract step does not implement it:

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
npm run db:migrate
npm run db:runtime
npm run db:worker
npm run test:ai-moderation-contracts
npm run test:ai-moderation-settings-store
npm run test:ai-shadow-contracts
npm run test:moderation-settings-contracts
npm run test:custom-blacklist-store
npm run test:monitoring-start
```

These tests require neither a livestream nor YouTube quota. Migration `024_ai_moderation_settings.sql` adds the new tables and triggers. Apply migrations before reprovisioning API and worker permissions. Persistence tests use temporary schemas and roles and clean them up afterward.

## Persistence and snapshots

`channel_ai_moderation_settings` stores consecutive immutable revisions per channel. `AiModerationSettingsStore` validates inputs, normalizes UUIDs, takes a per-channel transaction lock, rechecks the caller's authorization callback, and compares `expected_revision` before inserting. Conflicting writes return `AiModerationSettingsConflict` with the current revision. The caller must authorize reads; no public endpoint is exposed by this step.

An insert trigger captures the latest committed settings visible during run creation in `monitoring_ai_settings_snapshots`. It runs in the same transaction as `monitoring_runs`, so a failed run creation also rolls back its snapshot. Existing runs keep their captured revision after settings edits. Capture does not wait for an uncommitted newer revision or take the settings writer's advisory lock.

Snapshots have explicit provenance:

- `SAVED`: exact settings ID, revision, and configuration from the same channel.
- `DEFAULT`: no saved settings at capture time; ID, revision, and configuration are null.
- `LEGACY`: migration backfill for historical runs; ID, revision, and configuration are null. Application inserts cannot claim this source.

Null configuration means no AI enforcement policy. It does not imply a particular model or threshold. Database constraints validate configuration shape, score ordering, revision references, and channel relationships. Triggers prevent updates and deletes to historical settings and snapshots.

The API role can select and insert revisions and snapshots, as required by run creation. The worker can select captured snapshots only; it cannot read current channel AI settings or write either table. Runtime AI policy consumption is deferred to the worker integration step.

The next step exposes authorized settings endpoints with validation and revision conflict handling.
