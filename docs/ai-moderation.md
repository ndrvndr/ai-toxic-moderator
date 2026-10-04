# AI moderation thresholds

## Implementation status

Step 1 defines shared settings contracts, validation, public exports, and contract tests. It does not add database tables, settings endpoints, dashboard controls, or AI action dispatch. Existing AI output remains shadow output and does not change moderation decisions.

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

Run the contract checks manually:

```powershell
npm run format
npm run check
npm run build:core
npm run test:ai-moderation-contracts
npm run test:ai-shadow-contracts
npm run test:moderation-settings-contracts
```

These tests require neither a livestream nor YouTube quota. No database migration is needed for this step.

The next step adds immutable channel settings revisions and captured run snapshots, including a disabled policy for missing settings and legacy runs.
