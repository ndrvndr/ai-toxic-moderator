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

Run `npm run test:youtube-ban` for mock-transport tests. No test contacts YouTube.
The tests cover request construction, strict input validation, response matching,
cancellation, transport failure, and safe rejection handling.

Remaining work includes execution identity and attempt storage, authorization,
scheduling, timeout/ban conflicts for the same author, transactional live events,
dashboard status, and controlled live verification. DELETE retry rules must not be
reused implicitly: repeating a timeout may change how long the user is restricted.
