# Custom Blacklist

## Implementation status

Strict public contracts, a revision store, automatic run snapshots, authorized
HTTP endpoints, the Settings editor, a pure literal matcher, and a worker snapshot
reader are implemented. Blacklist entries are not yet
evaluated by the worker. Saving an enabled blacklist does not yet
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

The matcher uses the same NFKC, lowercase, trim, and whitespace
normalization as the contract. Invisible control/format characters in configured
patterns are rejected. Domain patterns use ASCII hostnames, including punycode,
without schemes, paths, ports, wildcards, or IP addresses. Domain extraction and
message matching are implemented separately from this contract validation.

| Action           | Required behavior                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `DELETE`         | Delete the matched message.                                                                                         |
| `DELETE_TIMEOUT` | Delete the message and request a timeout for its verified author. Requires `duration_seconds` between 1 and 86,400. |
| `DELETE_BAN`     | Delete the message and request a permanent ban for its verified author.                                             |

Duration bounds are application limits. Each executor must still enforce provider
constraints and target eligibility. IDs are canonicalized to lowercase; patterns
are canonicalized before duplicate checks. Duplicate IDs and duplicate patterns
within the same matching mode are rejected, including disabled entries. Different
matching modes may overlap; the matcher resolves their action priority deterministically.
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

1. Invoke the run snapshot matcher before AI processing in the classification pipeline.
2. Combined message/author action plans with separate execution outcomes and
   idempotency. Ban takes priority over timeout; deletion remains independent.
3. Decision provenance in chat and History, plus integration and live verification.

## Settings editor

Open `/settings/moderation` and select a channel. Owners can add, edit, disable,
and remove entries in the Custom blacklist section. Moderators can read the saved
configuration. Choose Word, Phrase, or Domain and an action for each entry.
Timeout actions require a duration in seconds. All patterns are literal and are
normalized when saved. The editor validates duplicates, durations, entry limits,
and the 16 KB request size before submission.

Saving appends a revision using the currently loaded revision number. Conflicts
and uncertain save failures retain the draft and block further writes until
Reload blacklist and discard changes is selected. Reloading replaces the draft
with the latest server record. Switching account or channel also resets the draft.
Background requests do not overwrite unsaved edits. Access failures hide the
entries and clear the scoped blacklist cache. Writes are never automatically retried.

The editor uses account/channel-scoped TanStack Query caches and validates the
response channel and saved revision. It clearly indicates that blacklist enforcement
is still pending. Saved changes are captured only by newly created monitoring runs.

Exceptions and AI thresholds are separate follow-up work. Blacklist matches are
explicit streamer policy; AI scores do not change their configured action.

## Literal matcher and action selection

`CustomBlacklistMatcher` in `packages/moderation-core` validates and copies a
configuration at construction. Disabled configurations and entries do not match.
Its `match` method is pure: it returns all matched entry IDs, one selected entry
ID, a message deletion decision, and an optional author action. It does not resolve
YouTube targets, perform database writes, call providers, or change existing worker
behavior. Worker integration must supply the captured run configuration, retain
decision provenance, and verify targets independently.

Word matching compares complete Unicode letter/mark/number/underscore tokens.
For example, `abc` matches `(ABC)` but does not match `abc99`, `abc_def`, or `xabc`.
Phrase matching uses literal substring comparisons after normalization. Regex
metacharacters are data and are never compiled into an expression.

Domain matching parses whitespace-separated HTTP/HTTPS URLs and bare domain
tokens, including paths and valid ports. Common enclosing punctuation is removed.
It compares only the parsed hostname, allowing an exact host or a subdomain with
a dot boundary. IDN URL hosts are converted to punycode by the URL parser. Email
addresses, credential-bearing URLs, backslash-containing tokens, other schemes,
protocol-relative URLs, invalid ports, and malformed tokens are ignored. This is
a conservative parser, not a general link detector: obfuscated links and adjacent
links without whitespace are not guaranteed to match. Paths and query strings
never supply domain evidence.

When multiple entries match, `DELETE_BAN` takes priority over `DELETE_TIMEOUT`,
which takes priority over `DELETE`. Among timeout entries, the longest configured
duration wins. Equal actions/durations resolve by ascending canonical entry ID;
all matching IDs are returned in ascending order. Reordering entries cannot change
the result. Every match still requests message deletion independently of the
selected author action. Matcher version: `blacklist-literal-1`.

These are policy decisions only. The existing single-action plan format still
needs an integration change before deletion and an author action can execute together.

## Worker snapshot reader

`RunBlacklistMatcher` reads `monitoring_blacklist_snapshots` through the supplied
transaction client, joining the monitoring run and binding its run, channel, and
session IDs. It validates both scope and snapshot metadata before constructing a
matcher. A missing, duplicate, mismatched, or invalid snapshot raises an error;
it never falls back to a channel's current configuration. Valid `DEFAULT` and
`LEGACY` snapshots produce no blacklist action.

The resulting decision includes the captured blacklist ID/revision, run/channel/
session IDs, snapshot source, and matcher version. Replay must pass the original
classification run ID, as the existing settings planner does. A new run can capture
a newer revision without changing an earlier run's result. No mutable channel
policy is cached or queried by this reader.

This helper is not yet invoked by `ClassificationStore` or the AI coordinator.
It does not persist decisions, skip inference, or send moderation requests.
The next integration step must preserve captured decision provenance and support
independent deletion and author action plans in the same transaction.

## Manual validation

Run from the repository root:

```powershell
npm run format
npm run check
npm run test:live-hooks
npm run build --workspace @moderator/dashboard
npm run build:core
npm run db:migrate
npm run db:runtime
npm run db:worker
npm run test:custom-blacklist-contracts
npm run test:custom-blacklist-matcher
npm run test:run-blacklist-matcher
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
