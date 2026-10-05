# Unban implementation

Unban is part of the portfolio MVP. It has two manual intents:

- **Unban** sends a removal request to YouTube using the provider ban ID stored
  for an authorized application-created ban.
- **Already unbanned in YouTube Studio** records an explicit streamer
  confirmation. It does not claim independent confirmation from YouTube.

## Implementation steps

| Step | Scope                                                                                                         | Status                                 |
| ---- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1    | Strict request/result contracts and a single-attempt YouTube removal adapter                                  | Implemented and covered by local tests |
| 2    | New migration and scoped removal records, idempotency, audit identity and concurrent-request protection       | Pending                                |
| 3    | Authorized API workflow, token resolution and separate Studio confirmation path                               | Pending                                |
| 4    | Dispatch eligibility after removal; keep historical ban outcomes unchanged and suppress stale queued messages | Pending                                |
| 5    | Dashboard controls, confirmation dialogs, outcome display and Live/History refresh                            | Pending                                |
| 6    | Database/HTTP/UI integration tests and controlled livestream E2E verification                                 | Pending                                |

The adapter is not wired to an HTTP endpoint or dashboard yet. No actual ban is
removed by installing this foundation.

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
npm run check
```

Tests use replacement transports and synthetic identifiers. No Google token,
YouTube request, database reset or real viewer moderation is involved.
