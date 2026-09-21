# Controlled live deletion test

This opt-in development rule tests the deletion pipeline. It is not a toxicity
classifier and must not be used as the production moderation policy.

## Scope and behavior

The marker is exactly `ATM_DELETE_TEST_V1`, with no extra spaces, newline, or case
changes. Only the configured viewer channel can trigger it, and only in the configured
internal history session. Ordinary insult and gambling rules remain classification-only.
The test classifier may flag the marker as SPAM; this is synthetic test evidence.

Defaults remain disabled. The worker creates the test policy only when deletion is
enabled and both test scope fields are configured. The policy version includes a hash
of the session and author. Removing or changing the scope blocks old test plans at
execution eligibility checks. An already dispatched request cannot be recalled.
Other existing non-test DELETE plans remain governed by the normal executor checks.

## Preparation

1. Run formatting, typechecking, and the controlled policy and execution-store tests.
2. Use a livestream you own for this test and a separate viewer account you control.
3. Keep `YOUTUBE_DELETE_ENABLED=false`, start monitoring, and confirm ordinary chat
   ingestion and the dashboard WebSocket connection.
4. Obtain the internal `session_id` from the monitoring response. This is a UUID,
   not the YouTube broadcast ID. Obtain the viewer's `author_channel_id` from the
   chat API after sending an ordinary message from that viewer.
5. Stop the worker process. Set the following local `.env` fields, replacing both
   placeholders with the identifiers from the previous step:

```dotenv
YOUTUBE_DELETE_ENABLED=true
YOUTUBE_DELETE_TEST_SESSION_ID=<internal-session-uuid>
YOUTUBE_DELETE_TEST_AUTHOR_ID=<viewer-youtube-channel-id>
```

Worker and Google authentication must also remain enabled. Restart the worker with
`npm run dev:worker`; keep the API and dashboard running. Configuration changes take
effect only after restart. Send a new test marker after restart; previously ingested
messages are not automatically reclassified.

## Verification

1. Send one marker from the selected viewer in the selected livestream.
2. Confirm the original text and classification appear in the dashboard.
3. Confirm YouTube removes that message and the dashboard eventually shows Deleted
   without a manual refresh. PENDING or DISPATCHED can be too brief to observe.
4. Inspect WebSocket events for `chat.updated` and an advancing cursor.
5. Send an ordinary message and a marker with extra text from the test viewer;
   neither should be deleted by this policy. A marker from another viewer must
   also produce no DELETE plan from this test rule.
6. If the outcome is UNKNOWN, do not treat it as success or retry the same action.
   Record the observed YouTube and dashboard states for investigation.

## Cleanup and evidence

Stop the worker, restore `YOUTUBE_DELETE_ENABLED=false`, clear both test scope fields,
then restart if ingestion should continue. Stop monitoring when the test is complete.
Do not commit `.env` or credentials.

Record the session, test time, final action status, observed YouTube result, dashboard
refresh, negative checks, and cleanup in the verification documentation. These steps
are instructions, not evidence that live deletion has already passed.
