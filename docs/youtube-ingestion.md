# YouTube ingestion

The NestJS worker polls YouTube live chat and stores resource observations in
PostgreSQL. Monitoring runs serve as the persistent work list.

The ingestion loop does not currently use BullMQ.

## Configuration

The worker requires:

- WORKER_ENABLED=true
- GOOGLE_AUTH_ENABLED=true
- WORKER_DATABASE_URL using the dedicated worker role
- The same Google client configuration and TOKEN_ENCRYPTION_KEY as the API

Keep DATABASE_URL configured for the API. Keep MIGRATION_DATABASE_URL configured
for the migration account.

All database URLs must point to the same local database, using the appropriate
role for each process.

To provision the worker role, configure WORKER_DB_ROLE and WORKER_DB_PASSWORD,
then run:

```powershell
npm run build:core
npm run db:migrate
npm run db:worker
```

The default role name is moderator_worker. WORKER_DATABASE_URL must use the
matching username and password.

Never commit local credentials or .env.

## Running

Run the API, dashboard, and worker in separate terminals:

```powershell
npm run dev:api
```

```powershell
npm run dev:dashboard
```

```powershell
npm run dev:worker
```

An enabled worker prints:

```text
YouTube ingestion worker started.
```

It processes eligible active runs, including runs created before worker startup.
The dashboard Start button has not yet been connected to this flow; monitoring
can currently be started through the authenticated API.

Ctrl+C requests shutdown. The runtime cancels the active chat request, waits for
the cycle to settle, and closes its database pool.

## Stored data

- youtube_chat_observations stores immutable resource snapshots.
- youtube_chat_checkpoints stores continuation tokens, polling schedules,
  retry state, revisions, and chat completion.
- monitoring_worker_leases stores temporary worker ownership.
- monitoring_runs stores lifecycle status and safe error codes.

Snapshot deduplication uses session ID, external message ID, and payload hash.
A changed resource may produce another snapshot with the same external ID.

Counts of distinct external IDs represent chat resources, not exclusively
viewer text messages. Revision numbers are not message counts.

## Automated verification

Build both applications before running integration tests:

```powershell
npm run format
npm run check
npm run build:core
npm run build --workspace=@moderator/api
npm run build --workspace=@moderator/worker
npm run test:worker-lease
npm run test:worker-runtime
npm run test:youtube-chat-adapter
npm run test:ingestion-integration
```

Tests use temporary schemas in local TEST_DATABASE_URL.
Integration tests exercise separate API and worker roles with mocked external
Google/YouTube transport.

Recovery tests simulate abandoned leases and create replacement coordinator
instances. They do not establish recovery from every OS-level process failure.

## Live verification — 2026-09-15

The developer reported a successful test against a real YouTube livestream:

- The broadcast was listed with live chat available.
- Start created a STARTING run.
- The worker transitioned the run to RUNNING.
- Two distinct chat resource IDs were persisted.
- The observed checkpoint revision reached 42.
- The checkpoint reported no error.
- Stop transitioned through STOPPING to STOPPED.

The observed stop request and completion timestamps were approximately
0.65 seconds apart. This is one observation, not a performance guarantee.

## Remaining product work

Chat ingestion is available. Dashboard WebSocket delivery, moderation
classification, automatic actions, and user-facing history remain to be built.
