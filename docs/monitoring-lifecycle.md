# Monitoring lifecycle

The API supports starting, inspecting, and stopping monitoring runs for verified
YouTube broadcasts. The ingestion worker retrieves chat and persists observations.

WebSocket delivery, classification, and moderation actions are not implemented.

## Authentication and access

All endpoints require an authenticated dashboard session.

POST requests require an Origin header matching DASHBOARD_ORIGIN.
Start requests verify ownership through the connected Google account.
Status and stop requests require OWNER or MODERATOR channel membership.

Account IDs, credential IDs, channel mappings, and live chat IDs are resolved
by the server.

## Start monitoring

POST /v1/monitoring/start

Required headers:

- Content-Type: application/json
- Idempotency-Key: a UUID

```json
{
  "youtube_broadcast_id": "your-broadcast-id"
}
```

The response contains run and reused.

- A new run starts in STARTING.
- The worker sets RUNNING after successfully persisting a polling batch.
- A successful batch may contain no messages.
- Repeating a key returns its associated run with the current stored status.
- Reusing a key for another broadcast returns IDEMPOTENCY_KEY_CONFLICT.
- Different keys reuse an existing STARTING, RUNNING, or STOPPING run.
- Restarting a terminal run requires a new key and successful verification.

One broadcast maps to one history session. Monitoring restarts create new runs
within that session.

## Read status

GET /v1/channels/:channel_id/monitoring/:run_id

The response contains run. A missing run or a run belonging to another
channel returns MONITORING_RUN_NOT_FOUND.

## Stop monitoring

POST /v1/channels/:channel_id/monitoring/:run_id/stop

```json
{}
```

| Current status | Result                                           |
| -------------- | ------------------------------------------------ |
| STARTING       | STOPPED                                          |
| RUNNING        | STOPPING, then STOPPED after worker confirmation |
| STOPPING       | Unchanged until worker confirmation              |
| STOPPED        | Unchanged                                        |
| FAILED         | Unchanged                                        |

Repeated stop requests preserve the original stop timestamps and actor.

Stopping monitoring does not end the YouTube broadcast.

## Worker behavior

The worker uses expiring leases and generations to protect writes from stale
owners. Observations and checkpoints are committed in the same transaction.

Checkpoint revisions reject late responses from an earlier polling attempt.
Identical resource snapshots are deduplicated within the history session.

Transient provider failures use persisted backoff. Eight consecutive transient
failures terminate the run. Successful batches reset the failure count.
Credential, permission, quota, and invalid page-token errors fail the run
without automatic retry.

Chat completion is persisted with the final batch so a replacement worker can
finish the run without fetching that chat again.

See [YouTube ingestion](youtube-ingestion.md) for setup and verification.

## Dashboard explanations

Live and saved-session chat display the same monitoring lifecycle explanations.
Quota exhaustion, Google reconnection, YouTube permission, unavailable chat,
checkpoint errors, and exhausted retries have distinct messages. Unknown error
codes receive a generic explanation instead of exposing arbitrary error text.
Quota failures do not retry or restart automatically; wait until quota is
available before starting another run for an active broadcast.

`STOPPED` with a recorded stop request is shown separately from a run that ended
without one. The latter does not imply a known livestream end reason: the
current saved run has no dedicated normal-end reason field. `RUNNING` with a
stored transient error is shown as retrying; starting/stopping labels do not
claim active ingestion. Stored chat remains available after collection ends,
and a connected WebSocket does not mean YouTube ingestion or AI is active.

See [AI operational status](ai-operational-status.md) for the separate channel AI
indicator and validation scope.
