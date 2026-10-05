# Environment variable reference

Use the root `.env.example` as the normal local development template. API, worker,
database commands, and database integration-test scripts load the repository-root
`.env` through their Node commands. Next.js uses the dashboard directory instead.
Never put credentials in variables prefixed with `NEXT_PUBLIC_`.

This reference describes settings consumed by the current source code. It does
not read or disclose the contents of a developer's private `.env`.

## Application and account access

| Variable               | Purpose and requirements                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `development` or `test`; application configuration rejects production mode.                                                                    |
| `API_PORT`             | Local API port, default `3001`. Update the OAuth redirect and dashboard API address when changing it.                                          |
| `DASHBOARD_ORIGIN`     | Exact local browser origin, default `http://127.0.0.1:3000`, without a trailing slash. Used for trusted-origin checks and OAuth configuration. |
| `SESSION_TTL_SECONDS`  | Dashboard session lifetime, from 60 to 86400 seconds; default 3600.                                                                            |
| `GOOGLE_AUTH_ENABLED`  | Enables Google login; requires configured credentials and token encryption.                                                                    |
| `GOOGLE_CLIENT_ID`     | Google OAuth web client ID.                                                                                                                    |
| `GOOGLE_CLIENT_SECRET` | Backend-only OAuth secret.                                                                                                                     |
| `GOOGLE_REDIRECT_URI`  | Exact authorized OAuth callback; must use the dashboard hostname and configured API port.                                                      |
| `TOKEN_ENCRYPTION_KEY` | 64 hexadecimal characters representing 32 random bytes; shared by API and worker. Changing it prevents reading existing encrypted tokens.      |
| `DEV_AUTH_ENABLED`     | Optional development login, disabled by default. Requires an existing account.                                                                 |
| `DEV_ACCOUNT_ID`       | UUID of the development account; the default account is created by optional `db:seed`. Not needed for Google login.                            |

## Databases and infrastructure

| Variable                 | Purpose and requirements                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Local PostgreSQL API connection using its restricted runtime role.                                                                                                      |
| `MIGRATION_DATABASE_URL` | Database owner/admin connection for migrations, role provisioning, and local fixtures. Scripts have an API-URL fallback, but a separate admin URL should be configured. |
| `RUNTIME_DB_ROLE`        | API role name used by `db:runtime`; default `moderator_api`. Must match the API URL user.                                                                               |
| `RUNTIME_DB_PASSWORD`    | Raw API role password, at least 16 characters; URL-encode separately in the connection URL.                                                                             |
| `WORKER_DATABASE_URL`    | Local PostgreSQL worker connection using its restricted runtime role.                                                                                                   |
| `WORKER_DB_ROLE`         | Worker role name used by `db:worker`; default `moderator_worker`. Must match the worker URL user.                                                                       |
| `WORKER_DB_PASSWORD`     | Raw worker role password, at least 16 characters; URL-encode separately in the connection URL.                                                                          |
| `TEST_DATABASE_URL`      | Local integration-test connection. Tests create temporary schemas; some also require temporary role management.                                                         |
| `REDIS_HOST`             | Local Redis hostname; default `127.0.0.1`. Used by the registered queue infrastructure.                                                                                 |
| `REDIS_PORT`             | Set `16379` to match current Compose. The configuration fallback is the older `56379`, so keep the explicit template value.                                             |

Compose publishes PostgreSQL on `15432` and Redis on `16379`. Its
`POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` values are defined directly
in `compose.yaml`, not interpolated from the root `.env`. Changing those values
does not reset credentials in an existing database volume. Redis/BullMQ
infrastructure remains registered even though ingestion scheduling uses PostgreSQL.

## Worker, AI, and action execution

| Variable                         | Purpose and requirements                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_ENABLED`                 | Starts ingestion when true; still requires launching `dev:worker`. False exits without ingestion.                                                                         |
| `AI_AUTOMATIC_ENABLED`           | Discovers one eligible active run with captured enabled AI settings. Requires worker, Google auth, and a pinned model revision; cannot run with manual AI scope.          |
| `AI_SHADOW_MODEL_REVISION`       | Exact 40-character lowercase hexadecimal revision from the local model manifest. Also used by the API to save model identity with AI settings. API and worker must agree. |
| `AI_SHADOW_CACHE_DIRECTORY`      | Local artifact directory, default `.cache/ai-prototype`. Relative paths are resolved from the worker working directory; root dev commands start there.                    |
| `AI_SHADOW_STARTUP_TIMEOUT_MS`   | Isolated inference startup deadline, from 1 to 300000 milliseconds; default 30000.                                                                                        |
| `AI_SHADOW_INFERENCE_TIMEOUT_MS` | Per-message inference deadline, from 1 to 300000 milliseconds; default 5000.                                                                                              |
| `YOUTUBE_DELETE_ENABLED`         | Permits real message deletion. Requires worker and Google auth; captured plans and execution guards still apply.                                                          |
| `YOUTUBE_BAN_ENABLED`            | Permits real timeout and permanent ban requests. Requires worker and Google auth; captured plans and execution guards still apply.                                        |

The `AI_SHADOW_` prefix remains the configuration name for shared inference
settings; it does not imply automatic mode is observation-only. Executor switches
are off in the template. Streamer preferences and thresholds live in database
settings, not environment variables. Model ID, adapter version, and INT8 variant
are application-managed constants. The worker does not download model artifacts.

## Dashboard API address

`NEXT_PUBLIC_API_URL` is optional, defaulting to `http://127.0.0.1:3001`.
Set it in `apps/dashboard/.env.local` or the terminal environment before launching
Next.js. Setting it only in the repository-root `.env` does not configure Next.js.
Restart the dashboard after changes; production bundles capture public variables
at build time. This is a public API address, never a credential-bearing URL.

## Optional development test settings

These settings are still consumed by code. They are intentionally omitted from the
main template so the normal workflow uses saved channel settings and automatic
run discovery rather than fixed testing IDs.

| Variable                         | Purpose                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `AI_SHADOW_ENABLED`              | Enables manually scoped AI inference, default false. Requires worker, a run ID, and model revision.     |
| `AI_SHADOW_RUN_ID`               | UUID of the manual test run, default empty. Must be empty with automatic AI enabled.                    |
| `YOUTUBE_DELETE_TEST_SESSION_ID` | Session UUID for controlled deletion testing. Configure together with the test author.                  |
| `YOUTUBE_DELETE_TEST_AUTHOR_ID`  | YouTube author channel ID for controlled deletion testing, paired with the session.                     |
| `YOUTUBE_BAN_TEST_SESSION_ID`    | Session UUID for controlled timeout/ban testing. All three ban test fields must be configured together. |
| `YOUTUBE_BAN_TEST_AUTHOR_ID`     | YouTube author channel ID for controlled timeout/ban testing.                                           |
| `YOUTUBE_BAN_TEST_ACTION`        | `TIMEOUT` or `BAN` for the controlled test. Default empty.                                              |

Remove old test scope overrides for normal Settings-driven operation. An old fixed
scope can prevent the intended current run or author from being processed. See
[automatic AI monitoring](automatic-ai-monitoring.md) and the archived controlled
verification procedures before opting into manual testing.

The inference subprocess also receives operating-system runtime variables such as
`PATH`, `TEMP`, and `USERPROFILE`; these are not application configuration entries.
Build scripts set `NEXT_TELEMETRY_DISABLED` internally. None belongs in the normal
application template.
