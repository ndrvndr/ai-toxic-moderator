# Deletion integration verification

## Controlled live verification: 2026-09-21

Evidence source: user-reported observations from the local application and a real
YouTube livestream, not independently inspected by the coding agent.

| Check                                      | Reported result                                      |
| ------------------------------------------ | ---------------------------------------------------- |
| Exact marker `ATM_DELETE_TEST_V1`          | Message deleted on YouTube                           |
| Ordinary message `Hello test`              | Not deleted                                          |
| Extended marker `ATM_DELETE_TEST_V1 extra` | Not deleted                                          |
| Dashboard result                           | Displayed Deleted without a manual refresh           |
| Configuration cleanup                      | Deletion disabled and both test scope fields cleared |

This verifies the controlled marker-to-deletion path and automatic dashboard updates
for this reported scenario, not general toxicity detection accuracy.

The setup response identified session `bf6a9adb-ffe0-4bce-becf-655ed5c00855` and
broadcast `_OHmPrkqWFk`. It showed a STOPPED run before setup; it does not identify
the run that performed the successful deletion. The successful attempt ID, active run
ID, exact event cursor, and provider response were not supplied.

Remaining manual checks include a marker from another viewer, live reconnect/replay,
and confirmation of worker restart after configuration cleanup. Monitoring stop after
the successful test was not explicitly confirmed.

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

Keep `YOUTUBE_DELETE_ENABLED=false` outside an explicitly scoped controlled test.
The default deletion rule list remains empty. Do not describe phase 7 or end-to-end
live deletion as verified solely from these automated tests.

Execution results should be recorded after the commands are run. Adding this
document and the test cases does not establish that they have passed.
