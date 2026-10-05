# AI Toxic Moderator

A monorepo for automatic moderation of Indonesian YouTube Live Chat.

Google OAuth, live broadcast listing, the dashboard shell, monitoring lifecycle
endpoints, and YouTube chat ingestion are implemented.

The worker retrieves chat resources and persists observations with checkpoints,
deduplication, retry handling, and lease-based recovery.

The dashboard supports authenticated WebSocket updates, blacklist checks,
per-message moderation results, livestream history, and channel moderation Settings.
The worker can plan and execute DELETE, TIMEOUT, and BAN actions with existing
authorization and execution guards. Local AI inference, configurable severity
thresholds, and automatic action planning are implemented. Model quality has been
explored on 40 authored examples; safe and abusive scores overlap, so this is a
portfolio prototype rather than a validated replacement for human moderators.

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
- Authenticated WebSocket delivery with event replay and frontend reconnect handling.
- Blacklist-first checks and independently recorded AI decisions.
- Automatic deletion, repeated timeouts, permanent bans, and uncertain-outcome evidence.
- Saved livestream history, chat filters, message statistics, and action statistics.
- Versioned moderation Settings and immutable configuration snapshots per run.
- Custom blocked words, phrases, and domains with independent action choices.
- Local INT8 AI inference with pinned model identity and isolated native execution.
- Automatic AI discovery for eligible monitoring runs and captured action thresholds.
- AI operational status, bounded recovery, and separate planning/execution results.
- English Overview, compact Live chat, and readable History reports and settings.
- Streamer-facing public homepage and server-managed AI model configuration.
- Verified YouTube channel setup before starting monitoring.
- Dashboard recovery during temporary API outages, including when monitoring is idle.

A newly created run has status `STARTING`. The worker sets it to `RUNNING`
after successfully persisting a polling batch, which may contain no messages.

The Live dashboard connects Start, Stop, and monitoring status to the authenticated
API. Opening saved History does not start monitoring or contact YouTube for chat.

## Stack

- **Dashboard:** Next.js, React, TypeScript, Tailwind CSS, and shadcn/ui.
- **Server state:** TanStack Query.
- **Shared client state:** Zustand, where needed.
- **API:** NestJS with Express.
- **Worker:** A separate NestJS application context.
- **Database:** PostgreSQL with `pg` and explicit SQL migrations.
- **Queue infrastructure:** Redis and BullMQ dependencies are available.
- **Validation:** Zod.
- **Local AI:** Transformers.js tokenizer and ONNX Runtime CPU inference.
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
  - `15432`: PostgreSQL.
  - `16379`: Redis.

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

Apply migrations:

```powershell
npm run db:migrate
```

Google OAuth setup does not require seed data. For optional foundation fixtures or
development login with the default test account, run `npm run db:seed` separately.
The seed creates synthetic data; it does not set up a real YouTube channel or
enable moderation.

See the [environment variable reference](docs/environment.md) for all supported
application, database, dashboard, and optional test settings. Compose database
owner credentials are defined in `compose.yaml`; the root `.env` does not change them.

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
- `/overview`: authenticated workspace summary and shortcuts.
- `/live`: live broadcast page within the dashboard shell.
- `/history`: saved livestream sessions.
- `/history/[sessionId]`: saved chat, classification reasons, and statistics.
- `/settings/moderation`: channel action preferences and settings revisions.

The dashboard defaults to API address `http://127.0.0.1:3001`. If it changes, set
`NEXT_PUBLIC_API_URL` in `apps/dashboard/.env.local` or the terminal environment
before starting Next.js. Next.js does not automatically read the repository-root
`.env`. This browser-visible variable must never contain credentials.

A previously verified dashboard stays open during temporary API failures and
retries session verification automatically. Reloading while the API is offline
requires a fresh verification and displays an unavailable-session page until the
API returns. This does not depend on monitoring being active.

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

### Local AI and automatic actions

Prepare the local model artifacts before enabling automatic AI:

```powershell
node scripts/ai-prototype.mjs download
```

This explicit setup downloads the model. The worker itself does not download
artifacts. Copy the exact `revision` value from `.cache/ai-prototype/manifest.json`
into `AI_SHADOW_MODEL_REVISION`; do not enter the manifest path. The API and worker
must use the same revision. Model ID, adapter version, and INT8 variant are managed
by the application rather than streamer input fields.

```dotenv
AI_AUTOMATIC_ENABLED=true
AI_SHADOW_MODEL_REVISION=<40-character revision from the manifest>
AI_SHADOW_CACHE_DIRECTORY=.cache/ai-prototype
YOUTUBE_DELETE_ENABLED=true
YOUTUBE_BAN_ENABLED=true
```

`WORKER_ENABLED` and `GOOGLE_AUTH_ENABLED` must also be enabled and configured.
The action switches permit real requests: save the desired blocked-word rules
and AI action limits in Moderation before starting a new monitoring run. These
settings are captured per run; changing them does not modify an existing run.
Keep executor switches off when testing inference without provider actions.
Automatic AI currently supports one eligible run at a time.

Manual AI and controlled author/session test scopes are optional development
tools. They remain supported but are intentionally omitted from the normal
`.env.example` workflow; see [optional test settings](docs/environment.md#optional-development-test-settings).

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

The ingestion batch transaction persists blacklist checks and their action plans.
Blocked words, phrases, and domains take priority; unmatched messages can be evaluated
by AI using the monitoring run's captured settings. Built-in rules are retired and
no longer produce new decisions or authorize pending action plans. Historical rule
results remain readable. Provider dispatch requires the corresponding worker action
switches and current authorization. See [Moderation Settings](docs/moderation-settings.md).

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

Run dashboard component and live protocol checks:

```powershell
npm run test:live-hooks
npm run test:live-event-protocol
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

apps/api                 NestJS authentication, monitoring, chat, history, Settings, and WebSocket
apps/worker              Ingestion, classification, moderation execution, and recovery

packages/contracts       Shared Zod schemas and TypeScript contracts
packages/config          Development configuration validation
packages/persistence     SQL migrations and PostgreSQL transaction helpers
packages/moderation-core Rule detection, classification policy, and action planning
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

On October 3, 2026 (Asia/Jakarta), the developer explicitly reported that all
fresh-database E2E scenarios passed: Google login, monitoring, rule-based chat
classification, WebSocket reconnect/navigation cleanup, History, Settings snapshots,
DELETE, repeated TIMEOUT, BAN, and logout. See [the E2E report](docs/end-to-end-verification.md)
for supplied evidence and remaining verification limits. The assistant did not
execute these checks, and the result does not establish production readiness.

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

## Portfolio status and limits

The planned dashboard redesign is complete with automated checks and
developer-reported manual review. The local model ran on all 40 authored examples
on 2026-10-05. At severity threshold 0.50 it selected ten of eleven abusive examples
and one of twenty clear examples; at 0.56 it selected six abusive examples and no
clear examples. Threats, ambiguous messages, and out-of-scope concerns were counted
separately. These in-sample results are not independent accuracy estimates or
recommended production defaults. See [AI quality results](docs/ai-quality-results.md).

Portfolio strengths are the complete monitoring-to-report workflow, immutable
per-run settings, configurable blacklist/AI policy, reconnect and replay handling,
recovery, restricted database roles, and honest treatment of uncertain provider
outcomes. Successful execution does not prove that a model's decision was correct.
Toxicity scores do not establish spam, scam, or gambling-promotion detection.

Use the [portfolio demo guide](docs/portfolio-demo.md) to prepare a repeatable
demonstration. Final demo policy selection remains separate from the completed
technical evaluation. Integration/connection settings and production
security/deployment verification remain separate work. The application currently
enforces local development boundaries; this README does not describe a public
production deployment procedure.

On October 3, 2026, the developer indicated successful Settings-driven DELETE,
snapshot/restart, TIMEOUT, repeated-TIMEOUT, and BAN verification by continuing
after each procedure. See [historical verification notes](docs/archive/built-in-moderation-settings.md) for
the reported outcomes and evidence limits. The assistant did not run those checks.

Built-in rule enforcement is retired. The authored-example AI measurements above
do not establish independent accuracy, production throughput, or production
readiness. Final demo threshold selection and verification remain pending.

## Remaining MVP phases

Two feature and evaluation phases remain before closing the portfolio MVP.
Unban is part of the MVP scope and is not deferred to future work.

| Phase               | Scope                                                                                                                                                                                                                                                                         | Completion evidence                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unban               | Let an authorized streamer manually remove an application-created ban from the dashboard using its stored YouTube ban ID. Record the removal separately from the original ban, show confirmed or uncertain outcomes, and update dispatch eligibility after confirmed removal. | Tests for authorization, concurrent requests, provider failures and uncertain responses; live verification that the viewer can chat again and a subsequent qualifying message can be moderated. |
| Final AI evaluation | Choose and document demo thresholds, review false positives and missed abusive messages, and verify the final policy through the complete monitoring-to-report workflow. Keep model severity distinct from violation probability.                                             | A reproducible evaluation report with example provenance, model revision, thresholds, observed errors, limitations and final E2E results.                                                       |

The proposed MVP unban flow covers bans with a recorded provider ban ID.
An unknown ban outcome without an ID cannot be removed through that flow.
Removing a ban does not promise restoration of deleted messages. The original
ban record remains historical evidence, rather than being rewritten as a failed
action. Unban does not exempt later messages from the captured moderation policy.
The implementation is still pending.

YouTube supports this operation through
[liveChatBans.delete](https://developers.google.com/youtube/v3/live/docs/liveChatBans/delete),
which requires the ban ID and suitable channel-owner or moderator authorization.
A successful removal returns `204 No Content`.

## After MVP / future work

These are follow-up directions, not additional portfolio MVP feature phases.
Public deployment still requires completion of the applicable security release
gate, even when the portfolio MVP feature scope is complete.

| Area                          | Follow-up work                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production security           | Resolve credential exposure and dependency findings; verify HTTPS/WSS, Secure cookies, CSP, proxy configuration, restricted service access and distributed rate limits. See the security checklist and local audit. |
| Operations and data lifecycle | Define retention and deletion, secure logging, backups and restoration, incident response, monitoring and capacity limits. Review YouTube API data requirements before deployment.                                  |
| YouTube integration           | Improve quota visibility and reconnect guidance; reconcile moderation changes made outside the application, including removals through YouTube Studio.                                                              |
| Model quality                 | Evaluate on a larger independent Indonesian chat sample, improve handling of context and slang, and assess spam/scam/gambling detection separately from toxicity.                                                   |
| Product expansion             | Consider additional integrations, collaboration features and commercial account management only after the existing workflow is validated.                                                                           |

## Documentation

- [Environment variable reference](docs/environment.md)
- [Portfolio demo guide](docs/portfolio-demo.md)
- [Dashboard redesign](docs/dashboard-redesign.md)
- [AI quality evaluation](docs/ai-quality-evaluation.md)
- [AI quality results](docs/ai-quality-results.md)
- [Automatic AI monitoring](docs/automatic-ai-monitoring.md)
- [AI moderation settings and planning](docs/ai-moderation.md)
- [AI operational status](docs/ai-operational-status.md)
- [Custom blacklist](docs/custom-blacklist.md)
- [Worker resilience audit](docs/worker-resilience.md)
- [AI classification plan](docs/ai-classification-plan.md)
- [Development sessions](docs/dev-session-access.md)
- [Google OAuth setup](docs/google-oauth.md)
- [Monitoring lifecycle](docs/monitoring-lifecycle.md)
- [YouTube ingestion](docs/youtube-ingestion.md)
- [Live dashboard verification](docs/live-dashboard-verification.md)
- [Fresh-database E2E verification](docs/end-to-end-verification.md)
- [Livestream history verification](docs/history-verification.md)
- [Moderation Settings](docs/moderation-settings.md)
- [Moderation reconciliation](docs/moderation-reconciliation.md)
- [Security checklist](docs/security-checklist.md)
- [Local security audit and remaining release requirements](docs/security-audit-2026-10-05.md)
- [Product direction](docs/spec/04-live-product-direction.md)
- [Backlog](docs/spec/03-backlog.md)
- [Verification records](docs/verification.md)
