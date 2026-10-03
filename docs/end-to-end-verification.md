# End-to-End Verification

## Result and evidence scope

On October 3, 2026 (Asia/Jakarta), the developer explicitly reported that all
scenarios in the fresh-database end-to-end procedure passed and behaved as
expected. This record covers a manual development test using the real local API,
dashboard, worker, Google login, and YouTube livestream.

The assistant provided the procedure and edited this documentation. It did not
run terminal commands, perform browser checks, or independently inspect the test
database. This is a developer-reported result, not an automated E2E test result.

## Initial environment

- A new local PostgreSQL database named `moderator_e2e` was created without
  deleting the prior development database.
- All four connection variables targeted the new database: `MIGRATION_DATABASE_URL`,
  `DATABASE_URL`, `WORKER_DATABASE_URL`, and `TEST_DATABASE_URL`, using their
  respective roles.
- Shared packages built, migrations completed, and API/worker role provisioning
  succeeded. The developer supplied successful command output for these steps.
- Foundation seed data was omitted for this procedure.
- Google login succeeded and the developer confirmed that the initial History
  was empty.
- Controlled deletion and ban test scopes were cleared. Actions were configured
  through Moderation Settings and the corresponding worker dispatch switches.
- A separate viewer account was used for action tests; the procedure required
  that account to be neither the livestream owner nor a moderator.

## Reported scenario outcomes

| Stage                         | Reported successful checks                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monitoring and classification | Start transitioned from STARTING to RUNNING; safe chat displayed Allowed, matching insult chat displayed Flagged with its reason, and disabled actions did not delete either message.  |
| WebSocket delivery            | New chat generated event delivery, advanced the cursor, and appeared without a manual refresh.                                                                                         |
| API reconnect                 | Restarting the API restored the connection and used the last processed cursor through `after`.                                                                                         |
| Navigation cleanup            | Leaving Live closed its connection; returning established a new connection and resumed chat updates.                                                                                   |
| Stop and History              | Monitoring reached STOPPED, post-stop chat was not ingested, and stored chat, reasons, and statistics remained available after page reload.                                            |
| History filters               | Allowed, Review, and category filters worked without changing full-session statistics.                                                                                                 |
| DELETE                        | The matching message was deleted and the safe message retained; dashboard results updated without refresh.                                                                             |
| Run snapshot                  | Disabling Settings did not change the active run. After stop/restart, the new run flagged matching messages but did not execute deletion.                                              |
| TIMEOUT                       | A configured 30-second timeout was confirmed; messages were blocked from the owner's view during the restriction, then safe chat resumed.                                              |
| Repeated TIMEOUT              | A new violation after the scheduling window triggered another timeout in the same session.                                                                                             |
| BAN and recovery              | BAN was confirmed, the viewer appeared in Hidden users, and subsequent messages were not visible to the owner. After monitoring stopped and manual unban, safe chat was visible again. |
| Final History and logout      | Results remained on their triggering messages, action statistics were consistent after reload, and logout did not leave protected session data displayed.                              |

Successful request outcomes are historical execution results. They do not indicate
that the viewer is currently restricted, and removing a viewer from Hidden users
does not rewrite an earlier successful BAN record.

## Supplied browser evidence

The developer supplied this ready frame after navigating back to Live:

```json
{
  "type": "ready",
  "channel_id": "65aa6fd5-6339-49dc-b6fe-0745eef233f6",
  "session_id": "1b4e0c23-8362-4151-9804-74a1657e1b41",
  "cursor": "5"
}
```

The developer also observed `WebSocket is closed before the connection is
established.` during navigation. This warning was not treated as success by
itself; the procedure required a new ready connection, subsequent chat updates,
and no persistent reconnect loop or duplicate active Live connections. The final
report confirmed that all scenarios passed.

Run IDs, settings revision numbers, per-action provider responses, exact message
counts, and a browser Network export were not supplied for this complete sequence.
Do not infer them from the session ready frame.

## Repeatable procedure

1. Stop application processes and create a fresh local database. Point the four
   database URLs to it without changing their role credentials.
2. Run `npm run build:core`, `npm run db:migrate`, `npm run db:runtime`, and
   `npm run db:worker`. Skip `db:seed` for the empty-History scenario.
3. Start the API, dashboard, and worker in separate terminals. Sign in with Google
   and verify empty History before starting monitoring.
4. Start a YouTube livestream and monitoring. Send a safe message and a message
   matching the Direct insult rule. Initially keep dispatch switches disabled.
5. Verify WebSocket events, cursor advancement, API restart/reconnect, and navigation
   cleanup while monitoring remains active. Then stop monitoring and inspect History.
6. Configure Direct insult DELETE at minimum severity 2, enable deletion dispatch,
   restart the worker when environment switches change, and start a new run.
   Test a safe message and matching message. Disable Settings during that run,
   then compare active-run behavior with a new run after stop/restart.
7. Configure a 30-second TIMEOUT, enable ban/timeout dispatch, and start a new run.
   Verify actual owner-visible restrictions, recovery after timeout, and another
   violation after the conservative scheduling window.
8. Configure BAN and start a new run. Verify Hidden users and owner-visible chat
   blocking. Stop monitoring before removing the viewer from Hidden users.
9. Inspect final History, per-message action results, statistics, reload behavior,
   and logout. Record failures at the stage where they occur.

Each configured action test used a matching message containing `idiot`, alongside
safe messages. These samples exercise the current built-in rule, not general
Indonesian toxicity detection accuracy.

## Cleanup and remaining verification

The procedure ends by stopping monitoring and the worker, disabling
`YOUTUBE_DELETE_ENABLED` and `YOUTUBE_BAN_ENABLED`, restoring the test viewer's
YouTube access, and ending the livestream. Keep the E2E database when needed for
historical inspection. Returning to the previous database requires restoring the
four connection URLs and restarting application processes.

This test does not establish production readiness or complete security acceptance.
Production HTTPS/WSS, deployment, cross-account access/revocation browser checks,
all failure/recovery paths, quota exhaustion, performance, and classifier accuracy
remain separate verification scopes. AI model inference was not involved.

Related records: [Live dashboard](live-dashboard-verification.md),
[History](history-verification.md), [Moderation Settings](moderation-settings.md),
[reconciliation](moderation-reconciliation.md), and [security](security-checklist.md).
