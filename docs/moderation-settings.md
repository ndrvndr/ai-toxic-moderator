# Moderation Settings

## Current implementation

Shared Zod contracts, an immutable settings table, a transactional API-side
store, and validation/integration tests are available. Authenticated settings
endpoints, the Settings page, and worker integration are not implemented yet.
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

Schema validation checks the payload shape. It does not establish that a rule
exists or that its detection quality is suitable for enforcement. The settings
API must validate references against the supported rule catalog when implemented.

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

The store is not an authorization boundary. The upcoming service must authorize
channel access and obtain the actor from the authenticated session before calling
it. Monitoring integration must still preserve the selected settings revision for
audit and reproducible action planning.

## Remaining implementation sequence

1. Add authorized read/write APIs and supported-rule validation.
2. Build the channel Settings page with TanStack Query.
3. Connect persisted configuration snapshots to classification and action planning.
4. Verify enabled/disabled behavior, concurrent edits, channel access, and historical
   result consistency.

Existing execution guards, repeated-timeout scheduling, and UNKNOWN handling must
continue to apply when configurable policies are connected.

## Validation

Run from the repository root:

```powershell
npm run format
npm run typecheck
npm run build:core
npm run db:migrate
npm run db:runtime
npm run test:moderation-settings-contracts
npm run test:moderation-settings-store
npm test
npm run check
```

Store tests require a local `TEST_DATABASE_URL` with permission to create temporary
schemas and provision temporary roles, following the existing integration-test
setup. They migrate an isolated schema and exercise the store with API runtime
permissions. They cover concurrent initial/subsequent saves, stale revisions,
channel scoping, failed-insert rollback, and immutable history.

Contract tests validate configuration boundaries, action-specific fields, duplicate
rule references, strict write metadata, and public exports. Neither suite sends
requests to YouTube. Test code is available; execution results must be confirmed
by running these commands locally.
