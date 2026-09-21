# YouTube timeout and ban adapter

## Current scope

`YoutubeBanAdapter` implements a single provider request. It is exported for later
worker integration but is not instantiated by the worker, exposed through an API,
or selected by the action planner. No timeout or ban is enabled by this change.

The adapter uses `liveChatBans.insert` with `part=snippet`. TIMEOUT sends a temporary
ban with an explicit duration in seconds; BAN sends a permanent ban without a duration.
Both identify the live chat and the target author's YouTube channel. See the official
[insert reference](https://developers.google.com/youtube/v3/live/docs/liveChatBans/insert)
and [resource definition](https://developers.google.com/youtube/v3/live/docs/liveChatBans).

## Result handling

Invalid local inputs or cancellation before dispatch return NOT_SENT. Recognized HTTP
rejections return a safe code without exposing provider bodies. Once dispatch begins,
network failures and ambiguous responses become UNKNOWN and are never retried here.

Confirmation requires HTTP 200 or 201 and a valid ban resource with a nonempty ban ID,
matching live chat, author, ban type, and timeout duration. A mismatched or unreadable
success body remains UNKNOWN because the request may already have changed YouTube.
The returned ban ID must eventually be persisted with the attempt result.

The transport has a ten-second abort deadline and rejects redirects. It does not
validate channel membership, resolve credentials, enforce policy, or deduplicate
targets; those responsibilities belong to the future executor and persistence layer.

## Verification and remaining work

`BanExecutionStore` now provides database-backed `ensure`, `claim`, `complete`, and
`recoverExpired` operations. It derives the author, live chat, action, and duration
from the original plan. Identical plans reuse the original execution; conflicting
actions or durations are rejected. Duration remains a decimal string at the storage
boundary to preserve PostgreSQL bigint precision.

Claiming locks the execution and commits one dispatch marker. Completion requires
the matching owner/attempt and an unexpired database deadline; only confirmed success
stores a provider ban ID. Expired dispatches become UNKNOWN through bounded SKIP LOCKED
recovery. No status, including a 429 rejection, permits another attempt.

Claims, terminal results, and recovery publish `chat.updated` in the same transaction.
Publication failure rolls back the state change. The event scope is derived from
persisted provenance. The store does not contact YouTube, check current authorization,
or run automatically; executor and runtime wiring are still pending.

Database tests for both execution stores currently share the isolated fixture suite
run by `npm run test:delete-execution-store`. Ban cases cover target derivation,
conflicts, concurrent ownership/completion, immutable provider identity, expired
recovery, blocked retries, and event-publication rollback under worker permissions.

Migration `013_youtube_ban_execution.sql` adds immutable execution identity and
single-attempt history. The database validates the original plan, scoped author,
live chat, action, and duration. One execution per channel/session/author prevents
competing TIMEOUT and BAN actions or policy versions from silently replacing each
other. This initial lifecycle does not support repeated timeouts or escalation.

Attempts begin DISPATCHED and accept one terminal result. SUCCEEDED requires the
provider ban ID and HTTP 200 or 201; malformed success responses can remain UNKNOWN.
Every prior attempt blocks another one, including rate-limit rejections. DELETE retry
rules do not apply. Worker permissions allow insert/read, execution row locking, and
result-column updates; the API role has read-only access to these two tables.

Run `npm run test:classification-schema` for scope, identity, duration, result-shape,
and immutability checks. Apply migrations before reprovisioning runtime/worker roles.
No worker executor or live action is enabled by this schema.

Run `npm run test:youtube-ban` for mock-transport tests. No test contacts YouTube.
The tests cover request construction, strict input validation, response matching,
cancellation, transport failure, and safe rejection handling.

Remaining work includes authorization and executor integration, periodic recovery wiring,
scheduling, timeout/ban conflicts for the same author, transactional live events,
dashboard status, and controlled live verification. DELETE retry rules must not be
reused implicitly: repeating a timeout may change how long the user is restricted.
