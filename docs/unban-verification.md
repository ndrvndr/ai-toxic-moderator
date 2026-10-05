# Unban verification

## Evidence status

Controlled livestream verification is pending. This document is a procedure,
not a claim that a real YouTube unban succeeded. Record observed results below
before marking step 6 complete in [Unban implementation](unban.md).

Local automated tests cover contracts, provider response handling, scoped owner
authorization, concurrent requests, idempotent replay, expiry, preserved history,
post-removal eligibility, stale-message suppression and dashboard controls.
They use synthetic identifiers and replacement provider transports.

## Preparation

Keep the current database and branch `feat/unban`. A reset is unnecessary.
Use the livestream owner's Google account in the dashboard and a separate viewer
account that is neither the owner nor a moderator. These checks deliberately
ban that viewer; use an account you can remove from Hidden users afterward.

If migration 028 has not been applied to the application database, run:

```sh
npm run build:core
npm run db:migrate
npm run db:runtime
npm run db:worker
```

Retain the existing Google secrets, encryption key and database URLs. Verify
`GOOGLE_AUTH_ENABLED`, `WORKER_ENABLED`, `YOUTUBE_DELETE_ENABLED` and
`YOUTUBE_BAN_ENABLED` are enabled. Restart the relevant processes after environment
changes. The unban API uses the owner's stored Google authorization; it has no
separate unban environment switch.

For a deterministic test, temporarily disable AI in Moderation settings and
disable `AI_AUTOMATIC_ENABLED` in the worker environment. Clear any old controlled
delete/ban test scopes if present. Record the prior settings to restore afterward.
In **Blocked words**, enable one **Word** entry:

| Input   | Value            |
| ------- | ---------------- |
| Pattern | `e2eunbanmarker` |
| Action  | Delete + Ban     |
| Enabled | Yes              |

Save the section. Start a **new monitoring run** after saving so it captures the
test settings. Do not stop/restart monitoring between the scenarios below.

Run the API, dashboard and worker in separate terminals:

```sh
npm run dev:api
```

```sh
npm run dev:dashboard
```

```sh
npm run dev:worker
```

## Scenario A: application unban

1. Start the YouTube livestream and monitoring. Check **Live updates connected**.
2. From the viewer account, send `Hello before unban`. Confirm it appears in the
   owner's chat and dashboard. Then send `e2eunbanmarker`.
3. Wait for **Ban confirmed** on the marker's **Moderation details**. Verify the
   viewer appears in **YouTube Studio → Settings → Community → Hidden users**
   (the menu may be named Community moderation). Check actual restrictions from
   the owner's view; the viewer's own input box alone is not evidence of delivery.
4. In the dashboard, click **Unban viewer**, then **Close**. No unban POST should
   appear in Network and the viewer should remain hidden.
5. Reopen the dialog and click **Confirm unban** once. The application POST should
   return `removal.method: "YOUTUBE"` and `removal.status: "SUCCEEDED"`. Expect
   **Unban confirmed by YouTube** without refreshing. The original **Ban confirmed**
   remains a historical result. Pending, rejected or unknown outcomes do not pass
   this success check; retain their actual status for diagnosis.
6. Check that the viewer is no longer in Hidden users. After confirmation, send
   `Hello after application unban` from that viewer. Verify it is visible in the
   owner's YouTube chat and appears in the dashboard. Refresh the viewer's YouTube
   chat if it still displays a cached restriction. Do not use a message sent before
   removal as evidence of recovery.
7. Wait and verify old messages do not trigger another ban. Then send a **new**
   `e2eunbanmarker`. Expect a new confirmed ban belonging to that new message. The
   prior unban remains linked to the first ban; it must not release this second ban.

## Scenario B: explicit YouTube Studio confirmation

1. With the second ban confirmed, remove the viewer from Hidden users in YouTube
   Studio and save that change. Do not send another marker yet.
2. On the **second** ban's message, click **Already unbanned in YouTube Studio**.
   Close the dialog first to verify that cancellation sends nothing.
3. Open it again and click **Confirm already unbanned**. Expect
   `removal.method: "STUDIO_CONFIRMATION"`, `removal.status: "USER_CONFIRMED"` and
   **Unban confirmed by you**. It must not display **Unban confirmed by YouTube**
   for this record. This action records the owner's statement, not an independent
   provider check or another removal call.
4. Send `Hello after Studio confirmation`. Check delivery in the owner's YouTube
   chat and dashboard. Verify old messages do not produce a delayed ban.

## History, refresh and cleanup

1. In DevTools, record `chat.updated` delivery and cursor advancement after each
   removal. Live should update without a page refresh.
2. Open this stream in **History**. Verify the first message retains its original
   ban and provider-confirmed removal, while the second retains its separate ban
   and user-confirmed removal. Later safe messages must not inherit those results.
3. Reload History. Both removal results should remain stored, and neither ban
   should offer another removal request once confirmed.
4. Stop monitoring and wait for **STOPPED**. Verify the test viewer is no longer
   in Hidden users. Restore prior AI settings and remove/disable the marker entry,
   saving both sections as needed. Subsequent runs capture the restored settings.

Do not intentionally interrupt a real unban request to manufacture an unknown
outcome. Lost responses, replay and expiry are already covered by local tests.
Automatic synchronization of unrelated Studio changes remains after-MVP work.

## Result record

| Check                                                                            | Observed result |
| -------------------------------------------------------------------------------- | --------------- |
| Application removal confirmed and viewer visible to owner afterward              | Pending         |
| Cancelled dialogs sent no removal POST                                           | Pending         |
| A new marker caused a second ban in the same session                             | Pending         |
| Explicit Studio confirmation recorded USER_CONFIRMED separately                  | Pending         |
| Old messages did not cause an immediate delayed re-ban                           | Pending         |
| Live updated without refresh and cursors advanced                                | Pending         |
| History retained both results after reload without copying them to safe messages | Pending         |
| Monitoring stopped, viewer restored, marker and temporary settings cleaned up    | Pending         |

Record the date, run/session identifiers and failures without pasting credentials
or token-bearing Network exports. Stale-message suppression and concurrency are
proven by local database tests; simply seeing no delayed action in a livestream
does not independently exercise every race or queue boundary.
