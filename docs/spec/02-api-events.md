# API and event contracts v1

Status: original MVP wire contract specification. During implementation, these contracts become runtime schemas and OpenAPI definitions, with tests validating API/worker payloads against the same schemas. This document describes the planned first milestone; it is not an inventory of currently active endpoints. See the development session and Google OAuth guides for implemented authentication routes.

The server uses NestJS: controllers for endpoints, guards for session/membership checks, pipes for runtime validation, and an exception filter for the error format below. The @nestjs/bullmq processor explicitly validates envelopes against shared schemas; HTTP pipes do not automatically apply to queues. SSE must satisfy cursor semantics, report errors before opening the stream, and clean up on disconnect. The [updated product direction](04-live-product-direction.md) specifies WebSocket for the eventual live dashboard.

## Shared rules

- Prefix `/v1`; UTF-8 JSON; ISO 8601 UTC timestamps; UUID internal IDs.
- Request objects reject unknown fields. Body limit: 16 KiB. raw_text must contain 1–2,000 Unicode code points and cannot be whitespace-only. External IDs: 1–128 characters; display names: 1–100; notes: at most 2,000. The server does not trim or modify validated raw_text.
- All channel routes require a development session and membership. Missing session → 401; not a channel member → 403; resource outside an authorized channel → 404. SSE checks access on connection and periodically; revoked access closes the connection.
- State mutations validate Origin against the configured dashboard origin; credentialed CORS must not use a wildcard. The UI renders messages/evidence as text, not HTML.
- Responses include `X-Request-Id` (a server trace UUID). Error format: `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "field_errors": [], "trace_id": "uuid" } }`. field_errors contains `{field, code}` entries. Never send stack traces or credentials.
- Status codes: 400 invalid JSON/cursor; 401 unauthenticated; 403 forbidden; 404 resource missing; 409 idempotency/session conflict; 413 body too large; 422 invalid field; 429 rate limit; 503 dependency not ready. A 429 response includes Retry-After.

## Resources and endpoints

| Method/path                                                     | Request / query                                                           | Response                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET `/v1/me`                                                    | Session cookie                                                            | 200 account and channel memberships                                                        |
| GET `/v1/channels/:channel_id/sessions`                         | limit 1–100, default 20; optional cursor                                  | 200 items and next_cursor; each session has primary_run_id                                 |
| POST `/v1/channels/:channel_id/sessions/:session_id/messages`   | Synthetic message below                                                   | 202 message_id, task_id, status, nullable decision_id, duplicate                           |
| GET `/v1/channels/:channel_id/tasks/:task_id`                   | —                                                                         | 200 status QUEUED/RUNNING/COMPLETED/FAILED, nullable decision_id, nullable last_error_code |
| GET `/v1/channels/:channel_id/decisions`                        | Optional session_id and outcome; limit 1–100, default 50; optional cursor | 200 items (DecisionSummary), nullable next_cursor, watermark                               |
| GET `/v1/channels/:channel_id/decisions/:decision_id`           | —                                                                         | 200 DecisionDetail                                                                         |
| POST `/v1/channels/:channel_id/decisions/:decision_id/feedback` | Idempotency-Key UUID header and feedback                                  | 201 feedback; identical retry returns 200 with the existing record                         |
| GET `/v1/channels/:channel_id/events`                           | Last-Event-ID header or after query                                       | 200 text/event-stream                                                                      |
| GET `/health/live`                                              | —                                                                         | 200 process alive                                                                          |
| GET `/health/ready`                                             | —                                                                         | 200 dependencies ready or 503; no secrets/network details                                  |

Sessions, channels, accounts, and bundles are created by the development seed. There is no public seed endpoint. Worker status, oldest task age, and failed task counts are inspected through internal health checks/development CLI in this milestone.

Dashboard summaries are computed from the currently loaded decision list and must be labeled as applying to the displayed results only. There is no channel-wide aggregation yet. Minimum filters are session and outcome. Search, category filters, and global analytics belong to a later backlog.

### Message input

The sample payloads below retain Indonesian user content as domain test data. Their wording must not be translated when validating Indonesian moderation behavior.

```json
{
  "external_message_id": "fixture-001",
  "author_external_id": "viewer-01",
  "author_display_name": "Penonton demo",
  "raw_text": "ayo daftar judi online di contoh.invalid sekarang",
  "published_at": "2026-09-13T10:00:00.000Z"
}
```

The server sets source to SYNTHETIC. published_at must be valid; fixtures may use historical timestamps. The server assigns received_at. Closed session → 409 SESSION_CLOSED. Deduplication follows the message uniqueness constraint in the schema. Hash comparison includes all input fields above; published_at is canonicalized to UTC before hashing. Identical duplicates always return 202 with `duplicate: true` and the current task status; different content → 409 IDEMPOTENCY_CONFLICT.

### DecisionSummary

Fields: `id`, `message_id`, `session_id`, `evaluation_run_id`, `created_at`, `author_display_name`, `raw_text`, `outcome`, nullable `primary_category`, nullable `severity`, nullable `confidence`, `reason`, `mode: SIMULATION`, `actions`.

`actions` is an array of `{id, action_type: DELETE, status: SIMULATED}`; it is empty for ALLOW/REVIEW/ERROR. The UI separates category, severity, outcome, and action status badges. Null confidence is displayed as not yet calibrated, not 0%.

### DecisionDetail

Contains all summary fields plus:

- `message`: `{id, external_message_id, author_external_id, raw_text, published_at, received_at}`.
- `reason_code`: demo enum NO_RULE_MATCH, CONTEXT_REQUIRED, GAMBLING_PROMOTION, DIRECT_INSULT, PROCESSING_FAILED.
- `representations`: array of `{type, text, processor_version, mapping_quality}`. MVP type: RAW/NORMALIZED; mapping_quality: EXACT/UNAVAILABLE.
- `signals`: array of `{rule_id, rule_version, category, severity, strength, confidence, intent, evidence}`. severity: 0–4; strength: STRONG/AMBIGUOUS; confidence: null for the demo.
- `evidence`: an array within each signal containing `{representation_type, matched_text, normalized_span, raw_span, mapping_quality}`. Spans `{start, end}` use UTF-16 offsets and half-open ranges `[start,end)` to match JavaScript slicing. raw_span is nullable; when an exact mapping is unavailable, use null with mapping_quality UNAVAILABLE. Never guess positions.
- `risk_snapshot`: `{content_risk, intent_risk, behavior_risk, context_risk, availability}`. Numeric scores are not calculated in the MVP; all values are null and availability is NOT_EVALUATED. Rule/policy traces explain results without fabricated scores.
- `version_bundle`: `{schema_version: 1, configuration_bundle_id, processor_version, ruleset_version, policy_version, model: {status: DISABLED, version: null}}`.
- `feedback`: array of records `{id, label, corrected_category, corrected_outcome, notes, reviewer: {id, display_name}, created_at}`.

MVP normalization: Unicode NFKC → lowercase → whitespace normalization. Span mapping must handle Unicode length changes; if mapping is unavailable, normalized evidence is still displayed without raw-text highlighting. Leetspeak, compact candidates, and advanced mixed-language handling are deferred.

ERROR stores empty representations/signals arrays if the pipeline has not produced snapshots; risk is NOT_EVALUATED; reasons are safe and omit stack traces. Versions still come from the pinned bundle.

### Feedback

```json
{
  "label": "FALSE_POSITIVE",
  "corrected_category": null,
  "corrected_outcome": "ALLOW",
  "notes": "Pesan sedang mengutip contoh, bukan menghina."
}
```

label is required; other fields are optional/null unless required by the database schema's conditional validation. When present, corrected_category uses the blueprint taxonomy: PROFANITY, HARASSMENT, HATE, THREAT, SEXUAL, GAMBLING, SPAM, SCAM, PII, SELF_HARM_ENCOURAGEMENT, IMPERSONATION, SUSPICIOUS_LINK. The UI may accept a correction to a category whose detector is unavailable without claiming that category is supported.

Idempotency keys are scoped to the channel and reviewer. The hash includes decision_id and the canonical body, so reusing a key with another decision/body returns 409. Feedback is append-only; subsequent corrections use a new key. Feedback does not modify the outcome or automatic actions, and the reviewer is resolved from the session.

## Queue contract

`chat.accepted` envelope:

```json
{
  "event_id": "11111111-1111-4111-8111-111111111111",
  "event_type": "chat.accepted",
  "schema_version": 1,
  "channel_id": "22222222-2222-4222-8222-222222222222",
  "session_id": "33333333-3333-4333-8333-333333333333",
  "trace_id": "44444444-4444-4444-8444-444444444444",
  "occurred_at": "2026-09-13T10:00:00.000Z",
  "payload": {
    "message_id": "55555555-5555-4555-8555-555555555555",
    "task_id": "66666666-6666-4666-8666-666666666666",
    "evaluation_run_id": "77777777-7777-4777-8777-777777777777"
  }
}
```

The MVP queue is `moderation.process`, with job name `chat.accepted` and jobId event_id. The worker validates the schema, loads database resources, and checks that all channel/session/run identities match. Raw text is not copied into the queue. SIMULATED actions are written in the decision transaction without an action worker; `action.execute` is enabled only in the provider phase.

Maximum: 5 total attempts, exponential backoff with a 1-second base and 0–50% jitter; initial concurrency: 2. Values are defined in development configuration. Permanent contract errors are not retried; an incident is stored with the event ID. Worker logs are structured with trace_id/message_id/task_id/decision_id and omit raw text by default.

A reconciler checks nonterminal tasks without active/delayed jobs and attempts to enqueue them again with the same task identity. Task age alone must not be used to conclude that a job is missing. In-progress tasks follow the worker lock/renewal mechanism; shutdown stops accepting new work and waits for active work for a bounded period. Persistent database errors must not be converted into fabricated decisions presented as successfully stored.

## SSE, pagination, and reconnection

MVP event types: `moderation.created`, `feedback.created`, `resync.required`. Resource events carry event_id, channel_id, session_id, resource_id, occurred_at, and schema_version. For feedback events, `resource_id` identifies the decision that must be refreshed. The body contains no raw chat.

The SSE `id` is a per-channel sequence sent as a decimal string to avoid JavaScript integer precision limits. The UUID event ID is distinct from the sequence cursor.

```text
id: 42
event: moderation.created
data: {"schema_version":1,"event_id":"88888888-8888-4888-8888-888888888888","channel_id":"22222222-2222-4222-8222-222222222222","session_id":"33333333-3333-4333-8333-333333333333","resource_id":"99999999-9999-4999-8999-999999999999","occurred_at":"2026-09-13T10:00:01.000Z"}

```

1. Feed GET reads rows and a watermark from a consistent database snapshot, ordered by created_at DESC and then id DESC.
2. The client opens SSE with `after=watermark`. Browser reconnection uses Last-Event-ID; this header takes precedence over an old after query parameter.
3. The server sends persisted events with greater sequence values in ascending order. Keepalive comments are sent every 15 seconds; database reads use bounded lightweight polling.
4. The client deduplicates events, invalidates/queries the decision cache with active filters, and prevents stale fetches from overwriting newer state.
5. A cursor invalidated by reset/retention triggers `resync.required` and closes the stream; the client fetches a new snapshot and cursor. A malformed cursor returns 400.
6. Reconnection uses 1–30 second backoff with jitter, reset after a stable connection. The UI displays CONNECTING/LIVE/RECONNECTING/OFFLINE connection states.
7. Pause buffers at most 200 event references instead of inserting them into the display. Overflow triggers a snapshot refresh on resume. Open details and scroll position are not moved automatically.

REST cursors are opaque encodings of a created_at/id tuple, filter, and snapshot watermark, validated by the server. Pagination limits decisions to the snapshot watermark by joining `moderation.created` feed_events on resource_id, preventing new events from appearing in older pages. Cursors are not access credentials. `next_cursor: null` indicates the last page. Changing filters discards the old cursor. Session pagination uses a created_at/id tuple without a watermark because sessions are seeded and do not change in the MVP.
