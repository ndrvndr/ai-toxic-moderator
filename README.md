# AI Toxic Moderator

Google OAuth, live broadcast listing, the shadcn dashboard shell, and monitoring lifecycle endpoints are available. See [Google OAuth setup](docs/google-oauth.md) and [monitoring lifecycle](docs/monitoring-lifecycle.md).

Monitoring runs can be created, inspected, and stopped. Chat ingestion, WebSocket delivery, classification, and moderation actions are not implemented yet. A STARTING run does not indicate that chat ingestion is active.

A monorepo for moderating Indonesian YouTube Live Chat. The M1-01–03 foundation and M1-04 development session backend are available. Local login/logout, `/v1/me`, and channel session listing have been implemented. The detection pipeline, message ingestion, live event feed, feedback endpoint, and AI model are not yet available. Google authentication and broadcast listing are covered separately in the OAuth guide.

To enable and try development access, see [development sessions](docs/dev-session-access.md). The user's `.env` is not modified automatically; development login requires `DEV_AUTH_ENABLED=true`.

## Stack

Next.js 16.3.5 + React; NestJS 12.0.1 with Express; a separate NestJS worker with @nestjs/bullmq; strict TypeScript; PostgreSQL; Redis/BullMQ; and Zod for runtime contracts. The dashboard uses shadcn/ui with Tailwind. Persistence uses `pg` and explicit SQL migrations. An ORM is not required for this foundation. Resolved dependency versions are recorded in package-lock.json.

## Prerequisites

- Node.js 22.12+ on the 22 release line, or Node.js 24+; tested with Node 22.20.0 and npm 10.9.3.
- Docker Desktop running with Linux containers for local Compose.
- Available localhost ports: 3000 (dashboard), 3001 (API), 55432 (PostgreSQL), and 56379 (Redis).

## Setup

Run from the directory containing this README:

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d
npm run build:core
npm run db:migrate
npm run db:seed
npm run build
npm test
```

If `.env` already exists, update it without overwriting your configuration; skip the copy command above. Compose credentials are for local development. Application processes are restricted to loopback and reject production mode.

In separate terminals:

```powershell
npm run dev:api
```

```powershell
npm run dev:dashboard
```

Dashboard: http://127.0.0.1:3000. API: http://127.0.0.1:3001/health/live and /health/ready. Readiness checks database schema availability, including the session and OAuth tables; it does not indicate moderation pipeline readiness.

```powershell
npm run dev:worker
```

The worker initializes a NestJS application context and then exits successfully. It has no processor yet and does not consume jobs. `WORKER_ENABLED=true` only registers the foundation BullMQ connection/queue; it does not enable moderation. This is intentional until the M1-07 pipeline transactions are implemented.

## Testing

```powershell
npm run check
npm test
npm run test:google
$env:TEST_DATABASE_URL = 'postgresql://moderator:local_demo_only@127.0.0.1:55432/moderator'
npm run test:db
npm run test:auth
```

Database tests create a unique `test_<uuid>` schema and delete only that schema afterward; do not point them at a production database. They cover idempotent migrations/seeding, deduplication, channel/session isolation, immutable history, conditional feedback validation, simulation statuses, and transaction rollback.

Tests use Node's `--experimental-test-isolation=none` option to avoid child-process IPC restrictions in the Windows runner. Next builds use worker threads and the TypeScript compiler API; type checking remains enabled. Database integration tests use real PostgreSQL.

## Structure

```text
apps/dashboard           Next.js dashboard with English UI, shadcn/ui, login, and live pages
apps/api                 NestJS auth, access guards, Google OAuth, broadcasts, monitoring lifecycle, health
apps/worker              NestJS application context and BullMQ registration
packages/contracts       Zod schemas and shared API/queue types
packages/config          Development environment validation
packages/persistence     SQL migrations and pg transaction helper
packages/moderation-core Detection interface for M1-06
packages/provider-adapters Simulation executor interface
scripts                  Build, migration runner, and seed
tests                    Contract/config, OAuth, and database integration tests
docs                     Specifications and verification reports
```

## Foundation implementation decisions

- Migrations are protected by checksums and use transactions and an advisory lock. Subsequent schema changes require new migration files.
- Repeated seeding does not overwrite immutable bundles. The `foundation-0` bundle has empty rules and a disabled policy; it must not be presented as an implemented demo ruleset.
- Unique constraints and composite foreign keys enforce channel/session/run consistency and deduplication.
- Raw messages, bundles, decisions, feedback, and audit records reject UPDATE. `db:runtime` provisions a restricted API role; see the development session guide. The Compose account remains the development/migration account until DATABASE_URL is switched to the runtime role.
- The schema only permits DELETE actions with SIMULATED status. Cross-table invariants (outcome versus action count, terminal task versus decision, bundle versus version snapshot) will be enforced through transactional services in M1-07; the foundation schema does not replace those validations.
- `multer` is overridden to 2.3.0 to address an advisory in the transitive platform-express dependency. There is no upload endpoint. Review the override when updating NestJS.
- Docker ports are exposed only on localhost. Do not expose this foundation to the internet.

## Next steps

Implement a durable YouTube chat ingestion worker with run ownership, recovery
after process failure, polling checkpoints, and message deduplication.

Then connect persisted chat events to the dashboard through WebSocket delivery,
followed by classification and automatic moderation actions.

See the [monitoring lifecycle](docs/monitoring-lifecycle.md),
[product direction](docs/spec/04-live-product-direction.md), and
[backlog](docs/spec/03-backlog.md).

Moderation accuracy and performance have not been measured because the
classifier has not been implemented.
