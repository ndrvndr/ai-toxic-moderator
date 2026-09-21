# Deletion integration verification

## Automated coverage

Run `npm run test:delete-execution-store` after building core packages. The suite
uses an isolated PostgreSQL schema and the provisioned, unprivileged worker role.
The integration cases compose the real execution store, eligibility resolver,
executor, deletion adapter, event reader, and dashboard event parser. Token
acquisition and the adapter's HTTP transport are replaced with test doubles.
No Google request is made and no real chat message is deleted.

The integration cases verify:

- Two executor instances competing for one target send only one DELETE request.
- The dispatch record is visible through another connection before transport runs.
- A successful response creates a terminal result and replayable chat update events.
- The dashboard protocol parser requests a chat refresh from those stored events.
- A fresh executor instance cannot redispatch an already attempted target.
- A lost response persists UNKNOWN and remains blocked after an executor restart.
- Stopping monitoring during token acquisition prevents claim creation and dispatch.

Existing tests in the same suite cover publication rollback, concurrent recovery,
ownership, authorization changes, scope substitution, and immutable target identity.
HTTP response rendering and React components are covered separately by
`test:monitoring-http` and `test:live-hooks`.

## Verification limits

These tests begin with persisted classification and DELETE-plan fixtures. They do
not prove rule selection from an incoming YouTube message, actual OAuth token
refresh, a process crash, live socket delivery, browser rendering, or real YouTube
deletion. A fresh executor instance tests database-backed deduplication after loss
of process-local state; it is not a full process-crash test.

Keep `YOUTUBE_DELETE_ENABLED=false` until controlled live verification is prepared.
The default deletion rule list remains empty. Do not describe phase 7 or end-to-end
live deletion as verified solely from these automated tests.

Execution results should be recorded after the commands are run. Adding this
document and the test cases does not establish that they have passed.
