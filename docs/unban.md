# Unban implementation

Unban is part of the portfolio MVP. It has two manual intents:

- **Unban** sends a removal request to YouTube using the provider ban ID stored
  for an authorized application-created ban.
- **Already unbanned in YouTube Studio** records an explicit streamer
  confirmation. It does not claim independent confirmation from YouTube.

## Implementation steps

| Step | Scope                                                                                                         | Status                                        |
| ---- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1    | Strict request/result contracts and a single-attempt YouTube removal adapter                                  | Implemented and covered by local tests        |
| 2    | New migration and scoped removal records, idempotency, audit identity and concurrent-request protection       | Schema implemented and covered by local tests |
| 3    | Authorized API workflow, token resolution and separate Studio confirmation path                               | Implemented and covered by local HTTP tests   |
| 4    | Dispatch eligibility after removal; keep historical ban outcomes unchanged and suppress stale queued messages | Pending                                       |
| 5    | Dashboard controls, confirmation dialogs, outcome display and Live/History refresh                            | Pending                                       |
| 6    | Database/HTTP/UI integration tests and controlled livestream E2E verification                                 | Pending                                       |

The adapter is wired to the authorized API. Dashboard controls and updated
dispatch eligibility are still pending; the complete feature is not ready for
live verification yet.

Migration `028_youtube_unban_requests.sql` adds scoped removal history with
request identity, requester and credential-account identity, deadlines, and
terminal outcomes that cannot be rewritten. Only the channel owner can create
a removal record. The API has limited insert/result-update permissions; the
worker can read removal history but cannot create, update or delete it.

Both MVP intents currently target application-created, provider-confirmed
permanent bans. An unknown original ban or a temporary timeout is outside this
initial removal scope. A failed or unknown removal of a confirmed ban can be
followed by a separate explicit Studio confirmation. This preserves uncertainty
on the original removal request. Database uniqueness prevents concurrent active
removals and reuse of a request ID for a different target. The API implements
idempotent replay and scoped expiry recovery without sending another request.

## API workflow

The following owner-only resource uses the application's normal session cookie
and mutation Origin checks:

```text
/v1/channels/:channel_id/sessions/:session_id/ban-executions/:execution_id/unban
```

- `GET` returns the newest 50 removal records for the scoped execution. It also
  marks expired dispatched records unknown, publishing a chat update once.
- `POST` accepts one of the following bodies and returns `{ removal, reused }`.
  Generate a request UUID for each intentional operation and retain it when
  retrying the same HTTP request after losing its response.

```json
{ "request_id": "10000000-0000-4000-8000-000000000001", "method": "YOUTUBE" }
```

```json
{
  "request_id": "10000000-0000-4000-8000-000000000002",
  "method": "STUDIO_CONFIRMATION",
  "confirmed": true
}
```

The execution must resolve to a confirmed permanent ban within that channel and
session. The API obtains the ban ID and original credential-account identity
from stored provenance. Provider removal additionally requires enabled Google
authentication and the requester to be the original credential account; a
different owner must not use another account's stored tokens.

The dispatched record and live event commit before provider calls begin.
Token lookup/refresh happens outside that transaction. Owner/session access is
rechecked afterward, before removal. Failed token lookup or access revalidation
records `NOT_SENT`; an uncertain provider response records `UNKNOWN`. Result
recording remains possible after access revocation because the request has
already begun and its history must be preserved.

Replay with the same account and request ID returns the stored result without
another transport attempt. Reusing it for another target or intent is rejected.
A separate request is blocked when a removal is in progress or confirmed.
After an unknown result, a new provider attempt is blocked; the streamer can
instead explicitly confirm a removal performed in YouTube Studio. Rejected or
not-sent attempts allow a new intentional request with a new UUID.

Expiry recovery runs when that resource is next read or requested. It is not a
background scanner. Live events accompany record creation, completion and expiry
recovery in the same transaction. No provider ID or credential is returned in
the removal summary. These records do not yet change worker scheduling; step 4
implements that behavior.

## Outcome rules

- Only YouTube HTTP `204 No Content` confirms a removal request succeeded.
- HTTP `404` means the ban was not found. It does not prove this application
  removed the ban, and is not recorded as a successful removal.
- Transport failure, interruption after dispatch, unexpected success codes and
  server errors leave the request outcome unknown. No automatic retry is made.
- Studio confirmation has a distinct `USER_CONFIRMED` status. It must never be
  displayed as provider-confirmed success.
- Client requests carry a request ID and intent, not credentials, provider ban
  IDs, target identifiers or claimed provider outcomes. The server must resolve
  scope and target from the stored execution and recheck authorization.
- Removal records do not overwrite the original ban or its attempt history.
- Later implementation must release only the relevant ban's scheduling block;
  other unknown/in-progress actions remain protected. Messages queued before
  removal must not cause an immediate delayed re-ban.
- A subsequent qualifying message can trigger moderation again. Unban is not
  a whitelist exemption and does not promise restoration of deleted messages.

Automatic synchronization with YouTube Studio is after-MVP work.

## Provider reference

[YouTube liveChatBans.delete](https://developers.google.com/youtube/v3/live/docs/liveChatBans/delete)
requires a ban ID and channel-owner or moderator authorization with a supported
OAuth scope. It returns `204 No Content` on success.

## Local checks

```sh
npm run test:unban
npm run test:unban-http
npm run test:classification-schema
npm run check
```

Tests use replacement transports and synthetic identifiers. No Google token,
YouTube request, database reset or real viewer moderation is involved.
