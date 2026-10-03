# Moderation Settings

## Current implementation

Shared Zod contracts, an immutable settings table, a transactional API-side
store, authenticated settings endpoints, and validation/integration tests are
available. The Settings page is available at `/settings/moderation`.
Worker integration is not implemented yet.
These changes do not alter existing classification or controlled development
action behavior.

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

Saving settings currently persists configuration only; it does not start
monitoring or apply that configuration to the worker.

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
until the save completes. Monitoring integration must still preserve the selected settings revision for
audit and reproducible action planning.

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

The page explicitly explains that saved settings are not yet used for live
moderation. Enabling the preference currently stores configuration only.

## Remaining implementation sequence

1. Connect persisted configuration snapshots to classification and action planning.
2. Verify enabled/disabled behavior, concurrent edits, channel access, and historical
   result consistency.

Existing execution guards, repeated-timeout scheduling, and UNKNOWN handling must
continue to apply when configurable policies are connected.

## Validation

Run from the repository root:

```powershell
npm run format
npm run typecheck
npm run build:core
npm run build --workspace @moderator/api
npm run db:migrate
npm run db:runtime
npm run test:moderation-settings-contracts
npm run test:moderation-settings-store
npm run test:moderation-settings-http
npm run test:moderation-core
npm run test:classification-store
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

These browser checks verify settings persistence and editing behavior. They do
not verify enforcement by the worker, which remains a separate implementation step.
