# Live Dashboard Verification

## Verified

- Initial WebSocket connection returned a `ready` frame.
- The connection was authorized for the selected channel and session.
- A `chat.updated` event was delivered through WebSocket.
- The event cursor advanced from `6` to `7`.
- Verification date: 2026-09-20

## Pending

- Production HTTPS/WSS verification.

The developer explicitly reported successful API reconnect, cursor resume,
navigation cleanup, and stop confirmation in the October 3, 2026 fresh-database
[end-to-end verification](end-to-end-verification.md). These are reported browser
results; automated failure/replay coverage remains a separate source of evidence.

## Current Limitation

YouTube quota availability may affect future provider-level tests.
The automated protocol, authentication, authorization, and frontend hook tests
are covered separately.

## Phase Status

Phase 6 implementation is complete.
The local browser scenarios in the fresh-database E2E procedure were reported
complete on October 3, 2026. Production verification remains pending.

## Chat Classification Verification

Verified locally:

- New chat messages appear automatically in the dashboard.
- Unmatched messages display Allowed with severity 0/4.
- Messages matching the insult rule display Flagged, HARASSMENT, and severity 2/4.
- Classification reasons are visible.

These checks verify rule-based classification delivery and display.
Automatic deletion, timeout, and banning are not covered by this verification.

## Controlled Deletion Verification

On 2026-09-21, the user reported that the exact controlled deletion marker was removed
from YouTube and the dashboard displayed Deleted without a manual refresh. An ordinary
message and a marker with additional text were not removed. The user also confirmed
restoring the disabled test configuration.

See [deletion integration verification](deletion-integration-verification.md) for
evidence scope and remaining checks. This supplements the classification verification;
this historical deletion check did not cover TIMEOUT or BAN. Their later verifications
are recorded below; general production moderation accuracy remains unverified.

## Repeated Timeout Verification

### Verification status

Passed in a controlled live test, as reported by the developer on
September 23, 2026.

The test used the same YouTube livestream session and viewer account
for two separate timeout actions.

### Verified behavior

- The exact controlled marker triggered the first timeout.
- The dashboard displayed `Timeout confirmed`.
- After the first timeout ended, a normal message was accepted.
- The normal message did not inherit the previous action result.
- A new controlled marker triggered a second timeout in the same session.
- Each action result appeared on its triggering message.
- Dashboard updates appeared without a manual refresh.

### Execution rules

- One execution is allowed per triggering observation.
- Reprocessing the same observation does not create another execution.
- Claims for the same author and session are serialized.
- A successful timeout blocks further dispatch until its scheduling
  window has elapsed.
- Messages published before that window ends do not become queued
  timeout actions afterward.
- A new violation published after the window ends can trigger another
  timeout.
- An unresolved `UNKNOWN` outcome blocks further author actions in
  that session.
- A successful permanent ban blocks further author actions in that
  session.

The scheduling window is calculated conservatively from the recorded
completion time and requested timeout duration. It is not a live query
of the author's current restriction state on YouTube.

### Provider response handling

Observed successful YouTube responses omitted `snippet.liveChatId`
and `snippet.banDurationSeconds`.

The adapter accepts these omitted fields while still requiring:

- A successful HTTP response.
- The expected resource kind.
- A valid provider ban ID.
- The expected target author.
- The expected temporary or permanent ban type.

When the response includes a live chat ID or timeout duration, that value
must be valid and match the request.

Historical attempts recorded as `UNKNOWN` remain unchanged.

### Follow-up scope

- Evaluate production moderation policies independently of controlled
  test markers.

Permanent BAN verification is recorded below. Later implementation and verification
of evidence for uncertain outcomes are documented in
[moderation reconciliation](moderation-reconciliation.md). Historical request
outcomes remain separate from observed moderation events.

This verification establishes the controlled repeated-timeout flow.
It does not establish classifier accuracy or production readiness.

## Permanent Ban Verification

### Verification status

Passed in a controlled live test, as reported by the developer on
September 23, 2026 (Asia/Jakarta).

### Confirmed evidence

- The exact `ATM_BAN_TEST_V1` marker produced a BAN execution.
- The chat API returned `action: BAN`, `status: SUCCEEDED`, and
  `duration_seconds: null` for the triggering message.
- A `userBannedEvent` was received at
  `2026-09-22T20:52:12.449294Z`.
- Earlier messages from the test viewer appeared as deleted in YouTube.
- After the channel owner removed the test viewer from Hidden users,
  the viewer's `test unban` message became visible again.

The visible removal of earlier messages is separate from the
application's per-message DELETE execution history.

### Additional verified behavior

- A new probe message sent while the ban was active was not visible
  to the channel owner.
- The dashboard displayed `Ban confirmed` without a manual refresh.

### Manual unban limitation

Removing the viewer from Hidden users restores access on YouTube but
does not rewrite the application's historical successful BAN attempt.

The current worker still blocks further author actions in that session
when a successful BAN exists in its history. Synchronizing external
unban actions is not implemented.

## Settings-driven Moderation Verification

On October 3, 2026 (Asia/Jakarta), the developer indicated that the preceding
DELETE, snapshot/restart, TIMEOUT, repeated-TIMEOUT, and BAN procedures passed
by asking to continue. Under the agreed workflow, this means the preceding
checks were successful and committed. The assistant did not independently
execute these checks. Detailed provider responses and run IDs were not supplied
for this verification sequence.

Reported checks covered normal Settings, with controlled marker scopes cleared:

- A configured Direct insult rule selected DELETE for a matching message and
  retained a safe message.
- Disabling Settings preserved the active run's previously captured policy.
- After stop and restart, the new run classified matching messages but did not
  execute actions under the disabled snapshot.
- A configured 30-second TIMEOUT was confirmed, chat was blocked from the owner's
  view during the restriction, and safe chat resumed afterward.
- Another violation triggered a second timeout in the same session.
- A configured BAN was confirmed, the viewer appeared in Hidden users, and new
  messages were not visible to the owner.
- After monitoring stopped and the owner manually removed the viewer from Hidden
  users, safe chat became visible again.
- Action results appeared in the dashboard without a manual refresh.

See [Moderation Settings](moderation-settings.md) for immutable run snapshot
semantics, dispatch switches, and automated test coverage. These reported checks
did not independently resolve reconnect and cleanup checks at that stage. The later
[fresh-database E2E report](end-to-end-verification.md) covers those local browser
scenarios. Production HTTPS/WSS and classifier accuracy remain separate work.

## AI Threshold Moderation Verification

On October 4, 2026 (Asia/Jakarta), the developer reported that real livestream AI
DELETE, TIMEOUT, and BAN scenarios passed, including Live updates without a manual
refresh and the shared results in History. The assistant did not independently
execute the tests. See [AI moderation real-provider verification](ai-moderation.md#real-provider-verification)
for captured thresholds, model identity, executor switches, and evidence limits.

Pasted DELETE output showed a safe greeting with baseline `ALLOW`, model rating
`Safe`, and expected severity `0.1685`. It crossed the deliberately low test DELETE
threshold of `0.10` and displayed a separate confirmed deletion result. The developer
subsequently confirmed timeout worked after enabling `YOUTUBE_BAN_ENABLED`, then
reported all BAN checks passed.

These results establish the reported local threshold-to-executor flow for the
configured run. The low test thresholds are not recommended defaults, and the
results do not establish toxicity accuracy, high-volume performance, processing
for every livestream, or production readiness. Test cleanup was instructed and
should be completed before unrelated streams.

## AI Operational Status Verification

On October 4, 2026 (Asia/Jakarta), the developer reported that the manual browser
checks for the operational-status feature all passed: waiting with advancing
heartbeats, stale heartbeat after stopping the worker, recovery after restart,
active AI for the current eligible monitoring run, and return to waiting after
monitoring stopped. Status transitions appeared without a manual refresh.

These were developer-observed UI results with moderation executor switches
disabled. The assistant separately observed the real worker's waiting report and
advancing persisted heartbeats, but did not independently observe the final
browser scenarios. See [AI operational status](ai-operational-status.md#step-7-reported-local-browser-verification)
for the checklist results and limits. No real quota exhaustion or new moderation
execution is claimed by this verification.
