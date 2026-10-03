# Custom Blacklist End-to-End Verification

## Status

On October 4, 2026 (Asia/Jakarta), the developer reported that the primary
controlled livestream scenarios worked, then confirmed the snapshot and worker
restart checks. The preceding continuation also indicates that the local
integration step passed under the agreed workflow. The primary blacklist flow is
accepted on that basis. The assistant did not run commands, tests, or the browser.

The reported sequence covers safe controls, word-based deletion, two timeouts,
permanent ban, updates without refresh, History, active-run snapshot retention,
new-run configuration capture, and restart without duplicate dispatch. Detailed
run/message IDs, provider responses, attempt counts, and WebSocket frames were
not supplied. Phrase/domain browser checks, socket cleanup in this sequence, and
optional native AI exclusion are not established by the report.

The local test connects the real API, PostgreSQL runtime roles, run snapshots,
ingestion batch writer, classification/planning, dispatch eligibility, executors,
AI shadow selection, persisted event feed, and chat response. YouTube requests and
AI inference are simulated. It verifies replay, independent outcomes, stopped-run
history, and rollback. It does not open a browser, establish a real WebSocket, run
the native model, or prove an actual YouTube restriction.

## Local automated checks

From the repository root, with a local admin-capable `TEST_DATABASE_URL`:

```powershell
npm run format
npm run check
npm run build:core
npm run build --workspace @moderator/api
npm run build --workspace @moderator/worker
npm run test:ingestion-integration
npm run test:blacklist-action-store
npm run test:ai-shadow-schema
npm run test:monitoring-http
npm run test:live-hooks
npm run build --workspace @moderator/dashboard
```

These database tests create isolated schemas and temporary roles. They require
schema/role management permissions, do not reset application history, and do not
consume YouTube quota. Build before running tests that import generated code.

## Prepare the controlled livestream

1. Use a test livestream on your connected YouTube channel. Use a separate viewer
   account for test messages; observe YouTube Studio from the channel owner's
   account. The test viewer must not be the owner or an appointed moderator.
2. Stop existing monitoring and wait for `STOPPED`. Stop the worker while changing
   environment settings. Leave OAuth, encryption, database URLs, and existing
   secrets intact.
3. Use normal blacklist processing with these `.env` values:

   ```dotenv
   WORKER_ENABLED=true
   GOOGLE_AUTH_ENABLED=true
   YOUTUBE_DELETE_ENABLED=true
   YOUTUBE_BAN_ENABLED=true
   YOUTUBE_DELETE_TEST_SESSION_ID=
   YOUTUBE_DELETE_TEST_AUTHOR_ID=
   YOUTUBE_BAN_TEST_SESSION_ID=
   YOUTUBE_BAN_TEST_AUTHOR_ID=
   YOUTUBE_BAN_TEST_ACTION=
   AI_SHADOW_ENABLED=false
   ```

   Controlled marker scopes override normal classification; clear all of them.
   `YOUTUBE_BAN_ENABLED` enables both timeout and permanent-ban dispatch. The
   blacklist itself chooses the action per entry. No new environment variable is
   needed for blacklist matching.

4. Start API and dashboard in separate terminals:

   ```powershell
   npm run dev:api
   ```

   ```powershell
   npm run dev:dashboard
   ```

5. Log in at `http://127.0.0.1:3000/login`. Open Settings / Moderation and select
   the test channel. Record its existing settings. Temporarily disable automatic
   built-in actions to isolate blacklist action selection; this does not disable
   the independently enabled custom blacklist.
6. Enable Custom blacklist and save these entries before starting monitoring:

   | Match type           | Pattern                | Action           | Duration   |
   | -------------------- | ---------------------- | ---------------- | ---------- |
   | Word                 | `atmblacklistdelete`   | Delete           | —          |
   | Word                 | `atmblacklisttimeout`  | Delete + timeout | 30 seconds |
   | Word                 | `atmblacklistban`      | Delete + ban     | —          |
   | Phrase               | `atm blacklist phrase` | Delete           | —          |
   | Domain               | `spam-test.invalid`    | Delete           | —          |
   | Word, disabled entry | `atmblacklistdisabled` | Delete           | —          |

   Record the saved blacklist revision. The disabled entry remains disabled.

7. Start the test broadcast in YouTube Studio, then start monitoring from `/live`.
   Record `run.id`, `run.channel_id`, and `run.session_id` from the monitoring
   response. Start the worker in another terminal:

   ```powershell
   npm run dev:worker
   ```

   Wait for monitoring `RUNNING`. Open DevTools / Network / WS, select the
   `/v1/live` connection for this session, and record its `ready` cursor.

## Message deletion and literal matching

Send from the test viewer, one message at a time:

| Message                                      | Expected blacklist behavior       |
| -------------------------------------------- | --------------------------------- |
| `Hello blacklist test`                       | No blacklist match or action      |
| `atmblacklistdeleteextra`                    | No word match or action           |
| `atmblacklistdisabled`                       | No action from the disabled entry |
| `ATMBLACKLISTDELETE`                         | Word match; deletion only         |
| `visit atm blacklist phrase now`             | Phrase match; deletion only       |
| `https://spam-test.invalid/path`             | Domain match; deletion only       |
| `https://spam-test.invalid.example.org/path` | No domain match                   |

For matches, verify the Custom blacklist / Streamer policy panel shows the
captured pattern, action, and saved revision. The evaluation uses `BLACKLIST_MATCH`
with no inferred toxicity category/severity. Message deletion has its own result
panel. Check deletion in the owner's YouTube chat and confirm the safe messages
remain visible before any author timeout/ban. A `chat.updated` frame should cause
the dashboard to update without a manual refresh; record its cursor.

The chat response for matched messages should contain a `blacklist` summary and
`ai_shadow: null` for these new observations. Unmatched messages should have
`blacklist: null`. An absent AI panel while shadow is disabled is not, by itself,
evidence that inference was skipped.

## Repeated timeout

1. Send `atmblacklisttimeout` from the test viewer. Verify the configured action
   is deletion plus a 30-second timeout. Record the deletion result and timeout
   result separately; one result does not establish the other.
2. After a confirmed timeout, immediately attempt a new safe message from the
   viewer. Check from the owner's account that it does not arrive during the
   restriction. A local echo in the viewer's browser is insufficient evidence.
3. After the timeout expires, send a new safe message and confirm the owner sees
   it. Then send a new `atmblacklisttimeout` message. It should create another
   eligible timeout execution for the new message in the same session.
4. Confirm the second timeout and its restriction separately. Old message replay
   must not cause another request. Record both message/execution results.

Timeout confirmation records the request result, not whether a restriction is
still active. YouTube may also hide earlier safe messages from that author when
applying an author action. That behavior is separate from per-message DELETE
execution in this application.

## Permanent ban

1. After the timeout has expired, send `atmblacklistban` from the test viewer.
2. Verify the captured configured action is deletion plus permanent ban. Record
   both execution results and the dashboard update without refresh.
3. If the ban is confirmed, check the test viewer appears in YouTube Studio's
   Hidden users. Attempt a fresh safe message and confirm it does not appear in
   the owner's chat.
4. Stop monitoring and wait for `STOPPED`, then manually remove the test viewer
   from Hidden users. Verify safe chat can appear again. Manual unban does not
   rewrite the application's historical confirmed ban or unblock author actions
   in the old session; use a new session for further author-action tests.

An `UNKNOWN` outcome is not a pass or proof of failure. Record it, inspect the
stored evidence, and do not repeatedly send the trigger to force a retry.

## Snapshot, restart, and history

Use a separate test session after restoring the viewer's access, to avoid an old
confirmed ban blocking subsequent author actions. Keep the saved test blacklist
enabled before starting this run. Create a new YouTube broadcast for this session;
restarting monitoring on the old broadcast creates a new run in the same session.

1. Send `atmblacklistdelete` and record captured revision N.
2. While monitoring is still running, disable that entry and save revision N+1.
   Send a new `atmblacklistdelete` message: the current run should still delete
   it using revision N.
3. Stop monitoring and wait for `STOPPED`. Start monitoring again with a new run
   ID. Send the same marker as a new message: the newly captured revision N+1
   should not select that disabled entry.
4. Restart only the worker. Previously stored messages/results must not cause
   duplicate successful moderation attempts. New ingestion or lifecycle events
   can advance the cursor independently; compare the specific execution history.
5. Stop monitoring, open the session in History, and inspect both runs' messages.
   Old decisions retain revision N, configured actions, and provider outcomes.
   The new unmatched message has no blacklist panel. Current Settings must not
   replace the old message's captured provenance.
6. Navigate away through the sidebar. Verify the old WebSocket closes. Return to
   the session and confirm a new connection becomes ready and historical results
   remain visible.

## Optional native AI exclusion check

Use an enabled blacklist run that has not already banned the test viewer. After
recording its run ID, stop the worker, set `AI_SHADOW_ENABLED=true` and
`AI_SHADOW_RUN_ID` to that run ID, and retain the actual cached model revision and
cache directory. Restart the worker. Model artifacts must already be available.

Send one safe nonmatching message and one deletion-only blacklist marker. Verify
the safe message eventually has an AI shadow result, while the matched observation
has no stored AI result and remains a streamer-policy decision. Record the API
response for each message. Shadow runs only for its configured run ID; update it
and restart the worker if you start another run. Do not use absence of all AI
output as proof of successful exclusion.

## Cleanup and evidence

Stop monitoring and wait for `STOPPED`. Disable the temporary blacklist entries
and restore the recorded built-in settings. Remove the test viewer from Hidden
users if necessary. Stop the worker, restore action switches to their prior values
(or set them false), and disable shadow if it was enabled only for this check.
Keep application history; no database reset is required.

| Check                                     | Result          | Evidence                                                                                  |
| ----------------------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| Local integration suite                   | Reported passed | Developer continued after the automated step; command output was not supplied.            |
| Word matching and safe controls           | Reported passed | Developer confirmed the preceding marker and safe-message procedure.                      |
| Phrase/domain browser matching            | Not recorded    | Included in the extended procedure; no specific report was supplied.                      |
| Deletion-only effects                     | Reported passed | Developer confirmed the preceding owner-observation procedure.                            |
| First and repeated timeout                | Reported passed | Developer confirmed the two-timeout and restriction procedure.                            |
| Permanent ban and manual cleanup          | Reported passed | Developer confirmed the ban, Hidden users, and cleanup procedure.                         |
| Snapshot N / N+1 and new run              | Reported passed | Developer confirmed the follow-up snapshot procedure.                                     |
| Worker restart without duplicate dispatch | Reported passed | Developer confirmed the follow-up restart procedure; attempt counts were not supplied.    |
| Live update without refresh               | Reported passed | Developer confirmed the preceding no-refresh procedure; frames/cursors were not supplied. |
| History provenance                        | Reported passed | Developer confirmed the preceding History procedure.                                      |
| Socket cleanup in this sequence           | Not recorded    | No separate observation was supplied.                                                     |
| Optional native AI exclusion              | Not run         | Requires matching and nonmatching results with native shadow enabled.                     |

Record dates and observed results without including cookies, tokens, database
passwords, or connection URLs. Automated fixture results and real livestream
evidence should remain distinguishable.
