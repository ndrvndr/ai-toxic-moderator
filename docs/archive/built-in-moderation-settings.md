# Archived built-in moderation settings

This document preserves historical implementation and verification evidence. Built-in rule enforcement and its public settings routes are retired; see [current moderation settings](../moderation-settings.md).

# Moderation Settings

## Current implementation

Shared Zod contracts, an immutable settings table, a transactional API-side
store, authenticated settings endpoints, and validation/integration tests are
available. The Settings page is available at `/settings/moderation`.
Normal worker action planning consumes the immutable settings snapshot of the
classification's monitoring run. Classification rules and the controlled
development marker policies remain unchanged.

## Configuration

Settings describe automatic actions for a channel. They do not contain viewer
targets, message IDs, credentials, arbitrary regular expressions, or a replacement
classifier. Actions reference a detection rule and its exact version.

```json
{
  "schema_version": 1,
  "automatic_actions_enabled": false,
  "rules": [
    {
      "rule_id": "id.harassment.direct-insult",
      "rule_version": "1",
      "minimum_severity": 2,
      "action": "DELETE"
    }
  ]
}
```

This example describes the configuration shape; it is not a recommendation to
enable enforcement for that rule.

- `automatic_actions_enabled` is explicit. A disabled configuration may retain
  staged rules for later editing.
- An empty rule list selects no automatic actions, even when the switch is on.
- Each rule/version pair selects at most one action.
- `minimum_severity` is an integer from 1 through 4.
- DELETE and BAN have no duration field.
- TIMEOUT requires integer `duration_seconds` from 1 through 86,400. This is an
  application configuration bound, not a statement of YouTube's provider limits.
- Configuration supports at most 100 rules.

Schema validation checks the payload shape. The API additionally checks exact
rule/version references against the shared built-in catalog. Ambiguous rules
have no supported automatic actions and cannot be configured for enforcement,
including in disabled configurations. Controlled development marker rules are
not part of this catalog.

The catalog provides selectable capabilities; it does not establish classifier
accuracy or suitability of an action for production. The current worker uses
the same rule metadata with its existing detection patterns.

## Authenticated API

| Method | Endpoint                                             | Purpose                                   |
| ------ | ---------------------------------------------------- | ----------------------------------------- |
| GET    | `/v1/channels/:channel_id/moderation-settings`       | Read latest settings, or `settings: null` |
| GET    | `/v1/channels/:channel_id/moderation-settings/rules` | Read supported rule metadata and actions  |
| POST   | `/v1/channels/:channel_id/moderation-settings`       | Save a new settings revision              |

All endpoints require a current application session and channel access. OWNER
and MODERATOR can read settings and the catalog. Only OWNER can save changes.
Operators and accounts without a permitted membership are denied access.

POST requires JSON and an Origin matching `DASHBOARD_ORIGIN`. The write body is
shown below. Successful saves return HTTP 200 with `{ "settings": ... }`.
Stale revisions return HTTP 409 with code `SETTINGS_REVISION_CONFLICT`.
Malformed configuration and unsupported rule/action references return HTTP 422.

Saving settings does not start monitoring or change an existing run. A new run
captures the saved configuration for worker action planning.

## Versioned updates

The write payload contains `expected_revision` and `configuration` only.
Channel identity comes from the authorized endpoint context; the creating account
comes from the authenticated session.

```json
{
  "expected_revision": 0,
  "configuration": {
    "schema_version": 1,
    "automatic_actions_enabled": false,
    "rules": []
  }
}
```

Revision 0 means the client expects no stored settings. Stored records use
positive revisions and include server-assigned ID, channel ID, creating account,
and creation timestamp. A read response with `settings: null` explicitly means
that no record has been saved.

The store serializes writes per channel with a transaction-scoped advisory lock,
compares the expected revision, and throws `ModerationSettingsConflict` on stale
updates. Each successful save inserts a new immutable record. Two competing
writes with the same expected revision cannot both succeed. A failed insert rolls
back without consuming a revision.

Migration `018_channel_moderation_settings.sql` enforces consecutive revisions,
unique channel/revision pairs, account/channel references, and the top-level JSON
configuration shape. Full action-specific validation runs through the shared Zod
schema in the store. Database triggers reject row updates and deletion; the API
role receives SELECT and INSERT only on this table.

The store is not an authorization boundary. The service authorizes access and
gets the actor from the authenticated request, not the write body. Before saving,
it rechecks OWNER membership inside the store transaction, after acquiring the
channel lock. A shared membership row lock prevents that membership from changing
until the save completes.

## Monitoring run snapshots

Migration `019_monitoring_settings_snapshots.sql` records one immutable settings
snapshot per monitoring run. An AFTER INSERT trigger captures the latest committed
channel revision visible when the run is inserted. The run and snapshot commit or
roll back together. The trigger runs with the caller's permissions; the API role
has SELECT and INSERT, and the worker role has SELECT only on the snapshot table.

`SAVED` snapshots include the settings ID, revision, and configuration. Channels
without saved settings receive a `DEFAULT` snapshot with automatic actions disabled
and an empty rule list. Existing runs are backfilled as `LEGACY` with the same
disabled fallback, without assigning today's settings retrospectively. LEGACY does
not establish which policy was actually used for historical messages.

Reusing an active run or replaying an earlier start request preserves its snapshot.
A new run after monitoring stops captures the configuration visible at that new
start. Saving another revision never changes an existing run's snapshot. A save
concurrent with starting monitoring may be selected by that run or a later run,
depending on which revision is committed and visible at capture time.

The normal worker reads this snapshot through the batch transaction client. It
never reads the channel's latest settings during classification. Missing or invalid
snapshots fail the batch transaction rather than selecting an unrecorded policy.
On classification replay, planning uses persisted signals and the original
classification run, even if replay was requested from a later run.

## Worker action planning

Normal plans use `settings-run-<run_id>` as their action policy version, linking
each plan to the immutable snapshot. Classification retains its detector and
classification policy versions; preferences change action selection, not detection.

Disabled, DEFAULT, and LEGACY configurations produce NONE plans. Enabled settings
require an exact rule/version reference, a STRONG detection and supported catalog
entry, the catalog category, and the configured minimum severity. Removed or
unsupported catalog references do not select actions. If several signals qualify,
the highest severity wins, followed by rule ID and rule version for deterministic
selection. One classification selects at most one action.

DELETE targets the classified message. TIMEOUT and BAN target its author and require
a valid YouTube channel ID; missing or fallback author identities select NONE.
TIMEOUT uses the snapshot's configured duration. ActionPlanStore checks targets
against the persisted observation before saving the plan.

Planning does not establish execution success. Dispatch continues to require the
existing authorization, run/session lifecycle, credential scope, and execution
guards. `YOUTUBE_DELETE_ENABLED` gates deletion dispatch; `YOUTUBE_BAN_ENABLED`
gates timeout and ban dispatch. Repeated-timeout scheduling and UNKNOWN handling
remain unchanged. Stopping monitoring prevents new dispatch under its run guards.

A configured controlled development scope selects its dedicated marker detector
and planner instead of Settings for that worker instance. Do not use test scopes
when verifying normal Settings enforcement. Runtime switches remain the immediate
dispatch controls; saving disabled Settings only affects subsequently created runs.

## Dashboard Settings page

The Moderation sidebar link opens `/settings/moderation`. The page uses the
authenticated account's OWNER/MODERATOR memberships for channel selection.
Channel IDs are shown because the membership response currently has no channel
display names. Operators do not receive an editable or readable settings form.

The route renders a feature page. Separate components handle channel selection,
loading/error states, the configuration form, and individual rule controls.
TanStack Query owns server data and mutations; draft edits are local to the
selected account/channel and are discarded when either changes.

Owners can select an action and minimum severity for supported rules and set a
timeout duration. Ambiguous rules appear as information without action controls.
Moderators receive a read-only form. Historical references absent from the current
catalog remain visible; owners must explicitly remove them before saving.

Save sends the last loaded revision and performs no optimistic update or automatic
retry. Duplicate in-flight submits are blocked. A confirmed response updates only
the selected account/channel cache and displays the saved revision. A conflict or
unconfirmed save preserves the draft, disables further saves, and asks for an
explicit reload. Reload refreshes settings and the catalog and discards draft
changes. Background window-focus refresh is disabled for these queries so it
cannot replace edits during form entry.

The page explains that saved preferences apply to new monitoring runs and that
corresponding worker action switches must also be enabled for dispatch.

## Reported live verification

The developer subsequently explicitly confirmed that all scenarios in the
[fresh-database E2E procedure](end-to-end-verification.md) passed on October 3,
2026, including Settings-driven DELETE, run snapshot/restart behavior, repeated
TIMEOUT, and BAN. That report supplements the earlier workflow-based confirmation
below and records the available session evidence and remaining limits.

On October 3, 2026 (Asia/Jakarta), the developer indicated that each preceding
verification step passed by asking to continue, following the agreed convention
that continuing means the previous checks are safe and committed. These results
are developer-reported; the assistant did not run commands or independently
observe the browser or database. No run IDs or provider response captures were
supplied for these Settings-driven checks.

| Check                                | Reported outcome                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Settings-driven DELETE               | The matching insult message was deleted; the safe message was retained.                                             |
| Active run snapshot                  | Disabling Settings did not change the already active run's deletion behavior.                                       |
| Disabled configuration after restart | A new run still classified the matching message as flagged but did not delete it.                                   |
| Settings-driven TIMEOUT              | A 30-second timeout was confirmed and messages were blocked from the owner's view during the restriction.           |
| Repeated TIMEOUT                     | Chat resumed after the first timeout; a new violation triggered another timeout in the same session.                |
| Settings-driven BAN                  | BAN was confirmed, the test viewer appeared in Hidden users, and subsequent messages were not visible to the owner. |
| Manual recovery                      | After monitoring stopped and the viewer was removed from Hidden users, safe chat was visible again.                 |

The procedure used normal Settings with controlled marker scopes cleared, new
monitoring runs after configuration changes, and an account separate from the
owner/moderator. Dashboard action results were checked without manual refresh.
See [Live Dashboard Verification](live-dashboard-verification.md) for the combined
verification record.

Settings implementation and the reported live action checks are complete for this
development milestone. This does not establish classifier accuracy, production
readiness, or a complete browser acceptance result for History and access handling.
Record run IDs, settings revisions, and request outcomes during subsequent
reproducible verification. Integration/connection settings remain separate work.

## Validation

Run from the repository root:

```powershell
npm run format
npm run typecheck
npm run build:core
npm run build --workspace @moderator/api
npm run db:migrate
npm run db:runtime
npm run db:worker
npm run test:monitoring-start
npm run test:moderation-settings-contracts
npm run test:moderation-settings-store
npm run test:moderation-settings-http
npm run test:moderation-core
npm run test:classification-store
npm run test:settings-planner
npm run test:controlled-delete-policy
npm run test:controlled-ban-policy
npm run build --workspace @moderator/worker
npm run test:ingestion-integration
npm run test:delete-execution-store
npm run test:live-hooks
npm run build --workspace @moderator/dashboard
npm test
npm run check
```

Store tests require a local `TEST_DATABASE_URL` with permission to create temporary
schemas and provision temporary roles, following the existing integration-test
setup. They migrate an isolated schema and exercise the store with API runtime
permissions. They cover concurrent initial/subsequent saves, stale revisions,
channel scoping, failed-insert rollback, and immutable history.

HTTP tests use the real local API, database, and runtime role. They cover owner
writes, moderator reads, denied cross-channel/operator access, current sessions,
trusted Origin, unsupported rules, metadata injection, and HTTP revision conflicts.
Store tests additionally cover authorization rechecks after waiting on the channel
lock. No Google or YouTube transport is called by the Settings tests.

Monitoring start tests cover default and saved snapshots, exact revision capture,
channel isolation, active-run reuse, old-key replay, revision selection on restart,
immutable rows, invalid snapshot metadata, and transaction rollback. Google
broadcast verification is mocked in these tests. The monitoring HTTP suite also
exercises run creation with the API runtime role and its snapshot permissions.

Contract tests validate configuration boundaries, action-specific fields, duplicate
rule references, strict write metadata, and public exports. Test code is available; execution results must be confirmed
by running these commands locally.

Frontend Settings tests are included in `npm run test:live-hooks`. They cover
owner saves, explicit conflict reload, moderator read-only controls, unavailable
rules, duration validation, duplicate submissions, account/channel draft isolation,
access errors, and response scope validation.

## Manual dashboard verification

1. Start the API and dashboard. The ingestion worker can remain stopped.
2. Sign in and open `/settings/moderation` from the sidebar.
3. Select a channel where your account is OWNER. Keep automatic actions disabled
   while checking persistence.
4. Choose Timeout author for a supported rule, set a duration, and save. Check
   the success notice and saved revision.
5. Reload the page and verify that the same values are loaded from the API.
6. Open the page in two tabs at the same saved revision. Save a change in the first,
   then submit a different draft in the second. The second must show a revision
   conflict and retain its draft. Reload saved settings to discard the draft and
   load the current revision.
7. Change channel while editing and confirm that the previous channel's unsaved
   draft does not appear in the new channel.
8. With a MODERATOR membership, verify read-only controls and no Save button.

These browser checks verify settings persistence and editing behavior. Normal
Settings enforcement requires separate live verification with a new monitoring
run, supported configured rules, and the relevant worker dispatch switches.

Planner tests use real rule detections to verify DELETE, TIMEOUT, BAN, safe messages,
disabled settings, thresholds, unsupported references, and invalid author targets.
Ingestion integration tests exercise snapshots and action plan persistence with
the actual API and worker database roles, including settings edits during an
active run and disabled configuration after restart. They send no real moderation
requests to YouTube. Test execution and live outcomes must be verified locally.
