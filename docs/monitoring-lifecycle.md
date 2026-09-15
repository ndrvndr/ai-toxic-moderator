# Monitoring lifecycle

The API supports creating, reading, and stopping monitoring runs for verified
YouTube broadcasts.

Chat ingestion, WebSocket delivery, classification, and moderation actions are
not implemented yet. Creating a run does not start chat ingestion.

## Authentication and access

All endpoints require an authenticated dashboard session.

POST requests require an Origin header matching DASHBOARD_ORIGIN.
Start requests verify broadcast ownership through the connected Google account.
Status and stop requests require OWNER or MODERATOR channel membership.

Account IDs, credential IDs, channel mappings, and live chat IDs are resolved
by the server. Clients must not supply these fields in request bodies.

## Start monitoring

POST /v1/monitoring/start

Headers:

- Content-Type: application/json
- Idempotency-Key: a UUID

Request body:

```json
{
  "youtube_broadcast_id": "your-broadcast-id"
}
```
