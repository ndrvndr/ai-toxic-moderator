# Moderation Settings

## Current implementation

Shared Zod contracts and source-based validation tests are available.
Persistence, authenticated settings endpoints, the Settings page, and worker
integration are not implemented yet. These contracts do not change existing
classification or controlled development action behavior.

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

The persistence step must serialize writes per channel, compare the expected
revision, and reject stale updates. Saving a revision must create an immutable
record rather than rewriting historical configuration. Monitoring integration
must preserve the selected settings revision for audit and reproducible action
planning. These guarantees are requirements for the following steps, not behavior
provided by the Zod contracts alone.

## Remaining implementation sequence

1. Add immutable settings revisions and transactional concurrency checks.
2. Add authorized read/write APIs and supported-rule validation.
3. Build the channel Settings page with TanStack Query.
4. Connect persisted configuration snapshots to classification and action planning.
5. Verify enabled/disabled behavior, concurrent edits, channel access, and historical
   result consistency.

Existing execution guards, repeated-timeout scheduling, and UNKNOWN handling must
continue to apply when configurable policies are connected.

## Validation

Run from the repository root:

```powershell
npm run format
npm run typecheck
npm run test:moderation-settings-contracts
npm test
npm run check
```

These tests validate configuration boundaries, action-specific fields, duplicate
rule references, strict write metadata, and public contract exports. They do not
send requests to YouTube or test database concurrency.
