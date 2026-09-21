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
