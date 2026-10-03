# Custom Blacklist

## Implementation status

Strict public contracts, a revision store, automatic run snapshots, and authorized
HTTP endpoints are implemented. Blacklist entries are not yet shown in the
dashboard or evaluated by the worker. Saving an enabled blacklist does not yet
enable moderation actions. Existing moderation settings retain their current format.

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

## HTTP API

| Method | Route                                | Access                                                |
| ------ | ------------------------------------ | ----------------------------------------------------- |
| `GET`  | `/v1/channels/:channel_id/blacklist` | Current OWNER or MODERATOR membership                 |
| `POST` | `/v1/channels/:channel_id/blacklist` | Current OWNER membership and trusted dashboard Origin |

Both routes require a current authenticated dashboard session. Operator membership
and membership in another channel do not grant access. GET returns
`{ "blacklist": null }` when no revision exists; otherwise it returns the latest
record. Responses use the API's existing `Cache-Control: no-store` behavior.

POST replaces the complete configuration by appending a new immutable revision:

```json
{
  "expected_revision": 0,
  "configuration": {
    "schema_version": 1,
    "enabled": true,
    "rules": [
      {
        "id": "10000000-0000-4000-8000-000000000001",
        "enabled": true,
        "match_type": "WORD",
        "pattern": "abc",
        "action": "DELETE_TIMEOUT",
        "duration_seconds": 300
      }
    ]
  }
}
```

Use revision zero only when no record exists. Later updates send the revision
returned by GET or the previous POST. Successful saves return HTTP 200 and
`{ "blacklist": <record> }`. Removing an entry means submitting a new configuration
without it; disabling retains the entry with `enabled: false`. Neither operation
deletes prior revisions or changes existing run snapshots.

Stale or competing writes return HTTP 409 with `BLACKLIST_REVISION_CONFLICT`.
Reload the latest record before deliberately applying another edit; do not
automatically overwrite it. Validation failures return HTTP 422 with field paths
and safe error codes. Moderator writes return HTTP 403 with
`BLACKLIST_WRITE_FORBIDDEN`. Unauthorized channel access is rejected before body
validation or revision lookup. The service rechecks and locks owner membership
inside the save transaction after acquiring the channel revision lock.

Pattern, action, and duration validation uses the shared contract. Author targets,
message IDs, server ownership metadata, and arbitrary regex matching modes cannot
be injected through the request. Client entry IDs identify configuration entries,
not YouTube targets. The API's existing 16 KB JSON body limit also applies: the
100-entry contract limit does not guarantee that every maximum-length combination
fits a single request. Oversized requests return HTTP 413 without writing a revision.

## Remaining implementation

1. Settings editor for creating, editing, disabling, and removing entries.
2. Literal matcher and deterministic conflict handling before AI processing.
3. Combined message/author action plans with separate execution outcomes and
   idempotency. Ban takes priority over timeout; deletion remains independent.
4. Decision provenance in chat and History, plus integration and live verification.

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
npm run build --workspace @moderator/api
npm run test:custom-blacklist-http
npm run test:moderation-settings-http
npm run test:moderation-settings-contracts
npm run test:moderation-settings-store
npm run test:monitoring-start
```

Database tests require an admin-capable local `TEST_DATABASE_URL`. They create
isolated random schemas and temporary runtime roles, then clean them up. They cover
competing writers, validation, authorization rechecks, permissions, snapshot
immutability, uncommitted revisions, rollback, and legacy backfill. They do not call
YouTube or execute moderation. Commands and tests are executed manually by the developer.

HTTP tests boot the actual built NestJS API with an isolated PostgreSQL schema and
API runtime role. They cover authentication, Origin checks, current channel roles,
revision conflicts, normalization, invalid input, membership changes, immutable
history, and oversized request errors. Build the shared packages and API before
running them to avoid testing stale generated files.
