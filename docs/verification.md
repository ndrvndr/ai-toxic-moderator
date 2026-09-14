# Foundation verification

This document records historical verification runs. Results and limitations apply to the feature and environment identified in each section, not automatically to the current application.

## dev-session-access feature — September 14, 2026

- Strict TypeScript builds for all packages, the NestJS API, and worker: PASS.
- Dashboard TypeScript (`tsc --noEmit`): PASS. A total of 38 executable source/configuration files were compared with the tested copy; no differences were found.
- Total: 29 tests PASS (9 contract/config, 8 PostgreSQL foundation, 12 HTTP/auth/runtime permissions).
- The API was tested on a real HTTP server using a random loopback port, isolated PostgreSQL 18.0, and a runtime role without permissions to modify memberships or delete audit records/decisions.
- Tests cover login, logout, token hashes/cookies, rotation, expiration, restart, disabled authentication, Origin/Host, invalid/oversized payloads, revoked membership, the OPERATOR role, pagination, and bounded sessions.
- Source code remained in the Desktop project. Because the runner rejected build output writes on Desktop, compilation and tests used a temporary copy of the same source in a writable workspace. The user's database and `.env` were unchanged.
- The dashboard production build could not be repeated in that session's runner: Turbopack rejected linked dependencies outside the copied root; a Webpack attempt encountered spawn EPERM. This backend feature did not change the dashboard. The earlier foundation build is recorded below.
- Redis, the moderation pipeline, login UI, OIDC, and provider integration were outside this feature's scope. Runtime role provisioning was available through the CLI and tested on an isolated database; it had not been applied to the user's database.

## Foundation history

September 13, 2026. Environment: Windows, Node.js 22.20.0, npm 10.9.3, and isolated local native PostgreSQL 18.0. The Docker engine was not running during testing; Compose had not been tested from start to finish.

Results:

- Strict TypeScript builds for all shared packages, the NestJS API, and worker: PASS.
- Next.js production build with type checking and homepage prerendering: PASS.
- 8 contract/config tests: PASS.
- 8 PostgreSQL integration tests: PASS, using a unique schema cleaned up after testing.
- Migration and seed CLI against the test database: PASS; repeated runs in integration tests did not duplicate seed data.
- NestJS worker context bootstrap/shutdown with the queue disabled: PASS. Redis/BullMQ runtime had not been tested.
- Localhost API `/health/live` and `/health/ready` after migration: HTTP 200.
- Dashboard production server: HTTP 200, with foundation and NestJS content present.
- `docker compose config --quiet`: PASS. Container startup was not verified because the Docker engine was not running.
- npm audit after overriding multer to 2.3.0: 0 vulnerabilities at the time of the check; this is not a permanent guarantee.

Runner limitations: the default Node test mode and Next TypeScript CLI encountered `spawn EPERM`. Tests ran in a single Node process, while Next used worker threads and the TypeScript API. No type checks were disabled.

Not tested/implemented at that time: authentication, moderation pipeline, queue consumption, provider integration, real-time feed, feedback API, model, F01–F17 fixture classification, MVP E2E, throughput, and public deployment. The app shell had not undergone a browser visual review.

Backlog status at that time: M1-01 foundation available (the worker intentionally was not yet a consumer); M1-02 initial runtime schemas available, with OpenAPI endpoint implementation to follow domain API development; M1-03 migration/seed available. M1-04 and later items had not started. No claim of MVP completion was made.
