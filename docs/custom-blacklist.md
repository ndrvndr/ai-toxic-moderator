# Custom Blacklist

## Implementation status

Public contracts, revision storage, automatic run snapshots, authorized HTTP
endpoints, the Settings editor, literal matching, combined planning, transactional
persistence, classification integration, and executor provenance validation are
implemented. The normal worker evaluates the captured blacklist before built-in
rules. Linked and verified plans can execute while monitoring is active and the
corresponding worker action switches are enabled. Existing moderation settings
keep their format. AI shadow selection skips messages matched by the captured
blacklist without creating a model result for them.
Live and History chat display captured blacklist provenance separately from
provider execution results.

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

1. Verify the complete flow through integration tests and a controlled livestream.

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
response channel and saved revision. It explains that actions require their worker
switches. Saved changes are captured only by newly created monitoring runs.

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

These are policy decisions only. The combined planner creates compatible individual
plans. The executors verify their individual links and targets before sending
deletion and author requests independently.

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

`ClassificationStore` invokes this reader and saves the decision through the same
ingestion transaction. The reader itself does not persist decisions or send
requests. AI shadow selection separately checks the same original run snapshot.

## Combined action planner

`BlacklistActionPlanner` takes a validated captured run snapshot and computes the
match itself. The caller supplies classification/run/channel/session scope, the
original message ID, and an author channel ID or null. Run and channel must match
the snapshot; the worker reader and future persistence layer must also verify
classification/session scope and targets against database observations.

The `blacklistActionBundle` contract groups the selected entry/action, all matching
entry IDs, captured blacklist revision, matcher version, and zero to two individual
plans. A matched message always gets a `DELETE` plan. Timeout and ban selections
also get an author plan when the author has a valid YouTube channel ID. An invalid
or unavailable author produces `TARGET_UNAVAILABLE` while preserving deletion.
This status describes planning, not a provider response or a current restriction.

Each individual plan keeps the existing `moderationActionPlan` format. A deterministic
base policy version includes the matcher version and original run ID. Message plans
use the `:message` suffix and author plans use `:author`, so they have separate keys
under the existing `(classification_id, policy_version)` uniqueness constraint.
There is no change to applied migrations or existing built-in action planning.
Opaque message IDs are preserved, and no request outcomes are inferred or included.

Bundle validation rejects conflicting scopes, duplicate/swapped plan slots,
unexpected execution fields, missing deletion, incompatible author actions, and
inconsistent durations or match metadata. It does not prove that a supplied target
belongs to the classification. The persistence store revalidates both targets and
recomputes the decision from its immutable snapshot before saving the bundle.
The normal classification pipeline invokes the planner and store. Neither sends
provider requests; the existing executors perform dispatch after validation.

## Transactional decision persistence

Migration `022_youtube_blacklist_decisions.sql` adds immutable decision records
linked to separate message/author action plan IDs. Scoped foreign keys bind the
classification, original run, and individual plans. The insertion trigger checks
captured revision metadata, complete plan slots, persisted plan fields, and observed
targets. It does not implement literal matching in SQL; semantic matching and full
bundle validation remain the store's responsibility. Applied migrations are unchanged.

`BlacklistActionStore.save(client, bundle)` requires an already active transaction.
It starts a savepoint before reading or writing and serializes competing saves by
classification and policy version. It reads the persisted classification and its
text observation, resolves the original run snapshot, and recomputes the expected
bundle using database text and targets. Any difference from the submitted bundle
is rejected before writing action plans.

Individual plans retain the existing store's target verification and immutable
policy slots. The decision and both plan links are saved through the same supplied
client. Failure rolls back all writes made by the save operation, even if the caller
catches the error and commits other work in its transaction. Success releases the
savepoint without committing; the caller controls the final commit or rollback.
Missing transaction context is rejected by PostgreSQL before any writes occur.

Replay reuses the same decision ID and plan IDs. Conflicting stored decisions cannot
be silently replaced. No-match decisions retain captured provenance without plans;
an unavailable author retains deletion with `TARGET_UNAVAILABLE`. Updating channel
settings or starting another run never changes the original captured decision.

The worker receives SELECT/INSERT on decisions; the API receives SELECT only.
Neither runtime role can update, delete, or truncate decision history. Provision
both roles after migration. Persistence itself does not send provider requests.

## Classification pipeline

The normal factory uses classifier version `rules-blacklist-1`. It first looks up
any persisted classification, then resolves its original run snapshot. A fresh
blacklist match bypasses built-in detection and action planning and records
`ACTION_REQUIRED` with reason `BLACKLIST_MATCH`, empty signals, and null category
and severity. This is explicit streamer policy, not a model toxicity assessment.
Migration `023_blacklist_classification_reason.sql` supports this decision without
rewriting earlier migrations. Live evaluation and History reason contracts accept
the new reason; History displays uncategorized policy matches as Streamer policy.

Matched decisions save independent deletion and optional timeout/ban plans. If the
author target is unavailable, deletion is retained. No-match decisions also retain
their captured provenance, then use the existing built-in rules and settings
planner. Controlled development delete/ban policies keep their isolated behavior.
Explicit non-text YouTube events are skipped even when they contain display text.

Classification, blacklist audit, and action plans share the ingestion transaction;
a failed batch rolls them back together. Replay reuses the persisted classification
and its original run even when the caller supplies a newer run. The persistence
store rechecks database text, observed targets, and captured configuration.

## Executor provenance validation

Candidate discovery and dispatch eligibility use a shared scoped predicate for
blacklist plans. A plan must link to the correct message or author slot in an
immutable decision, its original classification/run, and a saved enabled snapshot.
The classification must have `BLACKLIST_MATCH` with no inferred category, severity,
or rule signals. The policy namespace and matcher version must match the captured
run. An unlinked plan or a built-in plan attached to a blacklist classification
cannot bypass this check.

`BlacklistDispatchProvenance` additionally loads the captured snapshot and the
database observation, parses the strict bundle contract, and recomputes the complete
decision with the supported matcher. It compares the recomputed bundle and selected
individual plan to persisted fields, including message/author targets, reason,
action, duration, and policy version. Structurally valid but semantically forged
evidence is rejected. The helper reads no current channel configuration and loads
no credentials. Incompatible evidence fails closed.

Existing authorization checks still require active monitoring, an open YouTube
session/chat, current credential/requester membership, OAuth scopes, and enabled
action switches. Eligibility is rechecked by the executors before claiming and
after the committed dispatch marker. Existing retry budgets and repeated-timeout
blocking rules remain in effect. This change adds no automatic retry for uncertain
author outcomes.

Deletion and the optional author request have independent execution records and
results. A rejected deletion does not prevent a separately eligible timeout or ban.
An unavailable author does not prevent deletion. Each request uses the existing
execution claim and result persistence; blacklist planning never calls YouTube.

## AI shadow exclusion

`AiShadowCandidateReader` excludes observations with a persisted, scoped
`BLACKLIST_MATCH` decision. For observations without that audit record, including
historical and controlled-test observations, it evaluates text against the original
run's captured snapshot. It never reads the current channel configuration. Missing,
invalid, or foreign snapshots fail before inference. Disabled, `DEFAULT`, and
`LEGACY` configurations retain normal shadow selection.

The reader scans pages of 50 observations using a local timestamp/ID cursor,
preserving PostgreSQL timestamp precision. Skipped observations do not prevent a
later eligible message from being selected. Cancellation is checked between reads
and rows. The cursor is local to selection and does not change ingestion checkpoints.

Skipped messages invoke no model prediction and create no shadow result or shadow
update event. They are not assigned a fabricated safe rating, error, or skipped
status. Previously stored AI results remain unchanged; selecting another model
revision still respects the captured blacklist. Nonmatching messages continue
through the opt-in shadow pipeline without changing moderation decisions.

Tests cover worker permissions, persisted audit exclusion, snapshot fallback across
pages, changed channel revisions, new runs, restart, model revisions, and preserved
historical output. Inference is simulated; these checks do not establish native
model performance or a new browser/livestream verification result.

## Live and History provenance

The authorized chat endpoint includes an optional nullable `blacklist` summary.
It links the latest displayed classification to its scoped immutable decision and
original run snapshot, rather than querying current channel settings. A newer
classification cannot inherit an older classification's blacklist provenance.
Unmatched and unaudited observations return null. Invalid captured metadata is
rejected before constructing a summary.

The summary contains the captured blacklist ID/revision, run ID, matcher version,
all matched entry IDs, the selected entry's literal pattern/matching mode/action,
and author planning status. It does not expose the full channel configuration,
unmatched patterns, action plan payloads, credentials, or provider internals.
Existing channel/session authorization and pagination still apply.

The shared `ChatBlacklist` component appears below the evaluation in both Live
and History. It labels the decision as Custom blacklist / Streamer policy and
describes the configured deletion plus optional timeout/ban. These are policy
choices, not claims that requests succeeded or restrictions remain active.
Existing deletion and author outcome panels remain independent. An unavailable
author target explains why no author plan exists while deletion is retained.
Captured IDs/revision and matching entry IDs are available under Blacklist details.
Literal patterns are rendered as React text, never HTML.

Dashboard tests cover all actions, unavailable targets, absent provenance, literal
markup, contract validation, and shared Live/History rendering updates. HTTP tests
cover captured revision retention after settings edits, new runs, pagination,
classification selection, restricted response fields, and owner/moderator access.
These tests use local fixtures and do not send YouTube moderation requests. Browser
and controlled livestream verification remain the next step.

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
npm run test:blacklist-action-planner
npm run test:blacklist-action-store
npm run test:ai-shadow-coordinator
npm run test:ai-shadow-cycle
npm run test:ai-shadow-schema
npm run test:ai-shadow-store
npm run test:delete-execution-store
npm run test:classification-store
npm run test:controlled-delete-policy
npm run test:controlled-ban-policy
npm run build --workspace @moderator/worker
npm run test:custom-blacklist-store
npm run build --workspace @moderator/api
npm run test:ingestion-integration
npm run test:custom-blacklist-http
npm run test:monitoring-http
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
