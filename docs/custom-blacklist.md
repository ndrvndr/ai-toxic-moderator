# Custom Blacklist

## Implementation status

Strict public contracts, a revision store, and automatic run snapshots are now
implemented. Blacklist entries are not yet accepted by an HTTP endpoint, shown in
the dashboard, or evaluated by the worker. Persistence does not enable moderation
actions. Existing moderation settings retain their current format.

## Entry contract

Each entry has a UUID `id`, explicit `enabled` boolean, `match_type`, literal
`pattern`, and one action. A configuration has `schema_version: 1`, an explicit
`enabled` boolean, and at most 100 entries. This version describes the blacklist
contract, not a replacement for the existing moderation settings schema.

| Match type | Intended behavior                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORD`     | Match one Unicode word at word boundaries. Punctuation and spaces require phrase matching.                                                                 |
| `PHRASE`   | Match a literal substring after normalization; regex metacharacters have no executable meaning.                                                            |
| `DOMAIN`   | Match an extracted URL hostname equal to the configured host or a subdomain with a dot boundary. Never match arbitrary text containing a domain substring. |

The future matcher must use the same NFKC, lowercase, trim, and whitespace
normalization as the contract. Invisible control/format characters in configured
patterns are rejected. Domain patterns use ASCII hostnames, including punycode,
without schemes, paths, ports, wildcards, or IP addresses. Domain extraction and
message matching are not implemented by this validation step.

| Action           | Required behavior                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `DELETE`         | Delete the matched message.                                                                                         |
| `DELETE_TIMEOUT` | Delete the message and request a timeout for its verified author. Requires `duration_seconds` between 1 and 86,400. |
| `DELETE_BAN`     | Delete the message and request a permanent ban for its verified author.                                             |

Duration bounds are application limits. Each executor must still enforce provider
constraints and target eligibility. IDs are canonicalized to lowercase; patterns
are canonicalized before duplicate checks. Duplicate IDs and duplicate patterns
within the same matching mode are rejected, including disabled entries. Different
matching modes may overlap; their resolution belongs to the future planner.
Client-supplied author/message targets and unknown fields are rejected.

Example validated entry:

```json
{
  "id": "10000000-0000-4000-8000-000000000001",
  "enabled": true,
  "match_type": "PHRASE",
  "pattern": "kantorbola99",
  "action": "DELETE_TIMEOUT",
  "duration_seconds": 300
}
```

## Immutable revisions and run snapshots

Migration `021_custom_blacklists.sql` adds `channel_custom_blacklists` and
`monitoring_blacklist_snapshots`, without changing applied migrations. Blacklist
revisions are independent of built-in moderation settings revisions.

`CustomBlacklistStore.save` validates and normalizes the full configuration,
serializes channel writers with an advisory transaction lock, requires an
authorization callback inside the transaction, and compares `expected_revision`
before appending a revision. Zero means no saved revision exists. A stale write
raises `CustomBlacklistConflict`; failed writes do not consume a revision.
The caller must separately authorize reads.

The database checks top-level configuration shape and consecutive revisions.
Detailed pattern/action validation is performed by the store; direct database
insertion is not a substitute for contract validation. Revision history is immutable.

Creating a monitoring run captures the latest committed blacklist revision visible
to the capture statement in the same transaction. Snapshot metadata and configuration
must exactly match that channel's saved revision. No saved blacklist produces an
empty, disabled `DEFAULT` snapshot. Prior runs receive empty, disabled `LEGACY`
snapshots during migration, without implying that this was their historical policy.

Editing the blacklist does not modify existing runs. Active-run reuse and old start
request replay retain the original snapshot because they do not insert a new run.
After monitoring stops, a new run captures the latest committed revision. Run and
snapshot roll back together. Uncommitted writes are not adopted; snapshots for
built-in settings and blacklist are separate version selections, not a combined
settings revision.

The API role can select/insert revision and snapshot rows but cannot update, delete,
or truncate them. The worker can only read captured blacklist snapshots, not edit
them or select current channel blacklist revisions. This keeps future enforcement
bound to a run rather than mutable current settings.

## Remaining implementation

1. Authorized blacklist API endpoints and revision-conflict responses.
2. Settings editor for creating, editing, disabling, and removing entries.
3. Literal matcher and deterministic conflict handling before AI processing.
4. Combined message/author action plans with separate execution outcomes and
   idempotency. Ban takes priority over timeout; deletion remains independent.
5. Decision provenance in chat and History, plus integration and live verification.

Exceptions and AI thresholds are separate follow-up work. Blacklist matches are
explicit streamer policy; AI scores do not change their configured action.

## Manual validation

Run from the repository root:

```powershell
npm run format
npm run check
npm run build:core
npm run db:migrate
npm run db:runtime
npm run db:worker
npm run test:custom-blacklist-contracts
npm run test:custom-blacklist-store
npm run test:moderation-settings-contracts
npm run test:moderation-settings-store
npm run test:monitoring-start
```

Database tests require an admin-capable local `TEST_DATABASE_URL`. They create
isolated random schemas and temporary runtime roles, then clean them up. They cover
competing writers, validation, authorization rechecks, permissions, snapshot
immutability, uncommitted revisions, rollback, and legacy backfill. They do not call
YouTube or execute moderation. Commands and tests are executed manually by the developer.
