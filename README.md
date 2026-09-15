# AI Toxic Moderator

A monorepo for automatic moderation of Indonesian YouTube Live Chat.

Google OAuth, live broadcast listing, the dashboard shell, monitoring lifecycle
endpoints, and YouTube chat ingestion are implemented.

The worker retrieves chat resources and persists observations with checkpoints,
deduplication, retry handling, and lease-based recovery.

Dashboard WebSocket delivery, classification, automatic moderation actions, and
user-facing history are not implemented yet.

## Current capabilities

- Google OAuth login and persistent dashboard sessions.
- Encrypted Google access and refresh token storage.
- Shared token refresh handling for the API and worker.
- Live broadcast listing and ownership verification.
- Idempotent Start Monitoring requests.
- Monitoring status and Stop Monitoring endpoints.
- One history session per YouTube broadcast.
- Persistent chat observations and polling checkpoints.
- Worker leases with generation-based ownership checks.
- Persisted retry schedules and chat completion.
- Separate database roles for the API and worker.

A newly created run has status `STARTING`. The worker sets it to `RUNNING`
after successfully persisting a polling batch, which may contain no messages.

The dashboard Start button has not yet been connected to the ingestion flow.
Monitoring can currently be started through the authenticated API.

## Stack

- **Dashboard:** Next.js, React, TypeScript, Tailwind CSS, and shadcn/ui.
- **Server state:** TanStack Query.
- **Shared client state:** Zustand, where needed.
- **API:** NestJS with Express.
- **Worker:** A separate NestJS application context.
- **Database:** PostgreSQL with `pg` and explicit SQL migrations.
- **Queue infrastructure:** Redis and BullMQ dependencies are available.
- **Validation:** Zod.
- **Tooling:** npm workspaces, TypeScript, Prettier, and import organization.

The ingestion worker currently uses PostgreSQL monitoring runs as its persistent
work list. It does not use BullMQ for ingestion scheduling.

Resolved dependency versions are recorded in `package-lock.json`.

## Prerequisites

- Node.js 22.12+ on the Node 22 release line, or Node.js 24+.
- Docker Desktop running Linux containers.
- A Google OAuth web application configured for local development.
- YouTube Data API v3 enabled in the Google Cloud project.
- A YouTube channel with livestreaming enabled for live verification.
- Available local ports:
  - `3000`: dashboard.
  - `3001`: API.
  - `55432`: PostgreSQL.
  - `56379`: Redis.

Local development has been exercised with Node.js 22.20.0 and npm 10.9.3.

## Initial setup

Run commands from the repository root:

```powershell
npm ci
```

If `.env` does not exist:

```powershell
Copy-Item .env.example .env
```

If `.env` already exists, update the required variables without overwriting
existing credentials.

Start local infrastructure and build shared packages:

```powershell
docker compose up -d
npm run build:core
```

Configure the database connections before applying migrations:

- `MIGRATION_DATABASE_URL`: local migration/admin connection.
- `DATABASE_URL`: API runtime connection.
- `WORKER_DATABASE_URL`: worker runtime connection.
- `TEST_DATABASE_URL`: local integration-test connection.

The API, worker, and migration connections must target the same development
database, using their respective roles. The test connection must support the
temporary schemas and roles used by integration tests.

Apply migrations and create the foundation fixtures:

```powershell
npm run db:migrate
npm run db:seed
```

The seed creates synthetic foundation data. It does not enable a functioning
moderation ruleset or classifier.

## Runtime database roles

Configure these variables in `.env`:

```dotenv
RUNTIME_DB_ROLE=moderator_api
RUNTIME_DB_PASSWORD=

WORKER_DB_ROLE=moderator_worker
WORKER_DB_PASSWORD=
```

Provide a separate strong password for each role, then provision them:

```powershell
npm run db:runtime
npm run db:worker
```

Configure `DATABASE_URL` to use the API role and `WORKER_DATABASE_URL` to use
the worker role. Keep `MIGRATION_DATABASE_URL` on the migration/admin account.

The provisioning scripts require passwords of at least 16 characters.
URL-encode passwords when necessary before including them in connection URLs.

Re-run the relevant provisioning script when runtime permissions change.

Never commit `.env` or real credentials.

## Google OAuth setup

Configure these variables in `.env`:

```dotenv
GOOGLE_AUTH_ENABLED=true
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://127.0.0.1:3001/v1/auth/google/callback
TOKEN_ENCRYPTION_KEY=
```

`TOKEN_ENCRYPTION_KEY` must contain 32 random bytes encoded as 64 hexadecimal
characters. The API and worker must use the same encryption key.

Register the exact callback URI in the Google OAuth client's authorized
redirect URIs. The hostname must match the dashboard configuration.

See [Google OAuth setup](docs/google-oauth.md) for details.

Development login is optional and controlled separately by
`DEV_AUTH_ENABLED`. See [development sessions](docs/dev-session-access.md).

## Running the application

Run each process in a separate terminal.

### API

```powershell
npm run dev:api
```

Default address:

```text
http://127.0.0.1:3001
```

Health endpoints:

```text
http://127.0.0.1:3001/health/live
http://127.0.0.1:3001/health/ready
```

API readiness does not establish worker activity or moderation readiness.

### Dashboard

```powershell
npm run dev:dashboard
```

Default address:

```text
http://127.0.0.1:3000
```

Current routes include:

- `/`: landing page.
- `/login`: authentication.
- `/live`: live broadcast page within the dashboard shell.

### Ingestion worker

Configure:

```dotenv
WORKER_ENABLED=true
GOOGLE_AUTH_ENABLED=true
```

Ensure `WORKER_DATABASE_URL` uses the provisioned worker role, then run:

```powershell
npm run dev:worker
```

Successful startup prints:

```text
YouTube ingestion worker started.
```

The worker processes eligible active runs, including runs created before
worker startup. With `WORKER_ENABLED=false`, it exits without starting ingestion.

Press `Ctrl+C` to request shutdown. The runtime cancels the active chat request,
waits for the cycle to settle, and closes the database pool.

See [YouTube ingestion](docs/youtube-ingestion.md) for configuration and
verification details.

## Monitoring lifecycle

The API provides:

| Method | Endpoint                                           | Purpose                          |
| ------ | -------------------------------------------------- | -------------------------------- |
| POST   | `/v1/monitoring/start`                             | Create or reuse a monitoring run |
| GET    | `/v1/channels/:channel_id/monitoring/:run_id`      | Read run status                  |
| POST   | `/v1/channels/:channel_id/monitoring/:run_id/stop` | Request monitoring shutdown      |

All endpoints require an authenticated session. POST requests require an
`Origin` header matching `DASHBOARD_ORIGIN`.

Start requests require a UUID `Idempotency-Key` header and this body:

```json
{
  "youtube_broadcast_id": "your-broadcast-id"
}
```

Stop requests require an empty JSON object:

```json
{}
```

Run statuses:

| Status     | Meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `STARTING` | The request is stored; ingestion has not persisted its first batch |
| `RUNNING`  | Ingestion has successfully persisted a polling batch               |
| `STOPPING` | A stop request is waiting for worker confirmation                  |
| `STOPPED`  | Monitoring has stopped                                             |
| `FAILED`   | Monitoring ended because of an error                               |

Stopping monitoring does not end the YouTube broadcast.

See [monitoring lifecycle](docs/monitoring-lifecycle.md) for access checks,
idempotency behavior, and state transitions.

## Ingestion guarantees and limits

- One YouTube broadcast maps to one history session.
- Monitoring restarts create additional runs within that session.
- Only one active run is allowed per session.
- Expiring leases and generations protect writes from stale workers.
- Observations and checkpoints are persisted in one transaction.
- Checkpoint revisions reject responses from earlier polling attempts.
- Snapshot deduplication uses session ID, external message ID, and payload hash.
- Changed resources can produce additional snapshots with the same external ID.
- Retry schedules survive worker restarts.
- Chat completion is persisted with the final batch.

Transient provider errors use backoff. Eight consecutive transient failures
terminate the run. Successful batches reset the failure count.

Credential, permission, quota, and invalid page-token errors fail the run
without automatic retry.

Counts of distinct external IDs represent chat resources, not exclusively
viewer text messages. Checkpoint revisions are not message counts.

Ingestion does not classify messages as safe or execute moderation actions.

## Testing

Run formatting and source checks:

```powershell
npm run format
npm run check
```

`npm run check` includes source typechecking with `tsc --noEmit` and formatting
checks.

Build shared packages and applications before tests that load compiled output:

```powershell
npm run build:core
npm run build --workspace=@moderator/api
npm run build --workspace=@moderator/worker
```

Run foundation and authentication tests:

```powershell
npm test
npm run test:db
npm run test:auth
npm run test:google
npm run test:google-service
```

Run monitoring and ingestion tests:

```powershell
npm run test:migration-checksum
npm run test:monitoring-schema
npm run test:monitoring-unit
npm run test:youtube-session
npm run test:monitoring-start
npm run test:monitoring-http
npm run test:ingestion-schema
npm run test:chat-observation-schema
npm run test:worker-lease
npm run test:worker-runtime
npm run test:youtube-chat-adapter
npm run test:ingestion-integration
```

Database tests require `TEST_DATABASE_URL` pointing to local PostgreSQL.
They create temporary schemas and, where needed, temporary runtime roles.

External Google/YouTube transport is mocked in automated integration tests.
Recovery tests simulate abandoned leases and replacement coordinator instances;
they do not establish recovery from every OS-level process failure.

Tests use Node's `--experimental-test-isolation=none` option to accommodate
Windows runner restrictions.

For a full project build:

```powershell
npm run build
```

## Project structure

```text
apps/dashboard
  app                    Next.js routes, layouts, and providers
  features               Feature pages, components, and hooks
  components             Shared components and shadcn/ui primitives
  lib                    Shared frontend utilities and API client

apps/api                 NestJS authentication, broadcasts, monitoring, and health
apps/worker              Ingestion runtime, coordinator, leases, polling, and retries

packages/contracts       Shared Zod schemas and TypeScript contracts
packages/config          Development configuration validation
packages/persistence     SQL migrations and PostgreSQL transaction helpers
packages/moderation-core Foundation detection interface
packages/provider-adapters Google provider, token store, chat adapter, simulation interface

scripts                  Builds, migrations, role provisioning, and formatting
tests                    Unit, database, HTTP, and ingestion integration tests
docs                     Setup guides, specifications, and verification records
```

Dashboard routes render feature components. TanStack Query handles server
state; Zustand is reserved for shared client state where needed.

Project documentation, UI content, explanatory comments, and commit messages
use English. Original-language moderation fixtures remain unchanged.

## Database migration policy

Applied SQL migrations must not be edited.

The migration runner checks stored checksums before applying new migrations.
It accepts equivalent LF and CRLF line endings, while continuing to reject
changes to SQL content, comments, whitespace, or trailing newlines.

Schema changes require new migration files.

Historical observation updates are rejected. Runtime roles restrict access
and write permissions separately for the API and worker.

## Live verification

On 2026-09-15, the developer reported a successful test against a real
YouTube livestream:

- The active broadcast was listed with live chat available.
- Monitoring transitioned from `STARTING` to `RUNNING`.
- Two distinct chat resource IDs were persisted.
- The observed checkpoint revision reached `42`.
- No checkpoint error was reported.
- Stop transitioned through `STOPPING` to `STOPPED`.

The observed stop completion took approximately 0.65 seconds after the stop
request. This is one observation, not a performance guarantee.

See [YouTube ingestion](docs/youtube-ingestion.md) for the verification scope.

## Next steps

1. Add authenticated chat observation endpoints with cursor pagination.
2. Connect Start, Stop, and monitoring status to the Live dashboard.
3. Implement authenticated WebSocket delivery and reconnect recovery.
4. Add message classification and moderation policies.
5. Execute and verify automatic delete, timeout, and ban actions.
6. Build livestream history, statistics, and settings.

Moderation accuracy and performance have not been measured because the
classifier has not been implemented.

## Documentation

- [Development sessions](docs/dev-session-access.md)
- [Google OAuth setup](docs/google-oauth.md)
- [Monitoring lifecycle](docs/monitoring-lifecycle.md)
- [YouTube ingestion](docs/youtube-ingestion.md)
- [Product direction](docs/spec/04-live-product-direction.md)
- [Backlog](docs/spec/03-backlog.md)
- [Verification records](docs/verification.md)
