# Live Dashboard Verification

## Verified

- Initial WebSocket connection returned a `ready` frame.
- The connection was authorized for the selected channel and session.
- A `chat.updated` event was delivered through WebSocket.
- The event cursor advanced from `6` to `7`.
- Verification date: 2026-09-20

## Pending

- Reconnection after restarting the API.
- Cursor replay after reconnect.
- WebSocket cleanup after leaving the Live page.
- Monitoring stop confirmation.
- Production HTTPS/WSS verification.

## Current Limitation

YouTube quota availability may affect future provider-level tests.
The automated protocol, authentication, authorization, and frontend hook tests
are covered separately.

## Phase Status

Phase 6 implementation is complete.
Manual browser verification is partially complete.

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
TIMEOUT, BAN, and general production moderation accuracy remain unverified.

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

### Remaining work

- Clearly distinguish blocked executions from pending executions.
- Verify permanent BAN behavior separately.
- Define reconciliation for uncertain provider outcomes.
- Evaluate production moderation policies independently of controlled
  test markers.

This verification establishes the controlled repeated-timeout flow.
It does not establish classifier accuracy or production readiness.
