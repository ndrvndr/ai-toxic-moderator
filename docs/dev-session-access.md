# Development sessions and channel access

Branch: `feat/dev-session-access`. This feature provides local backend authentication, not production/OIDC login. It does not modify the user's `.env` automatically. This guide describes the original development session feature; see [Google OAuth](google-oauth.md) for the later integration.

## Enabling development access

Add or update these values in `.env`:

```dotenv
DEV_AUTH_ENABLED=true
DEV_ACCOUNT_ID=10000000-0000-4000-8000-000000000001
DASHBOARD_ORIGIN=http://127.0.0.1:3000
SESSION_TTL_SECONDS=3600
```

Then run from the project root:

```powershell
npm run build:core
npm run db:migrate
npm run db:seed
npm run dev:api
```

Migration `002_development_sessions.sql` adds session storage. Earlier migrations are unchanged. Login uses the seeded moderator account by default. `DEV_AUTH_ENABLED` defaults to false; configuration validation rejects production mode and public origins.

## Trying it with PowerShell

In another terminal:

```powershell
$api = 'http://127.0.0.1:3001'
$origin = @{ Origin = 'http://127.0.0.1:3000' }

Invoke-RestMethod "$api/v1/auth/dev-session" -Method Post -Headers $origin -ContentType 'application/json' -Body '{}' -SessionVariable devSession
Invoke-RestMethod "$api/v1/me" -WebSession $devSession
Invoke-RestMethod "$api/v1/channels/20000000-0000-4000-8000-000000000001/sessions" -WebSession $devSession
Invoke-RestMethod "$api/v1/auth/logout" -Method Post -Headers $origin -ContentType 'application/json' -Body '{}' -WebSession $devSession
```

After logout, `/v1/me` returns 401 for the old cookie. Browser requests must use `credentials: 'include'`. Use a consistent host for the API and dashboard (for example, 127.0.0.1 for both), because SameSite Strict cookies are not sent across sites. A dashboard login form was outside the scope of this backend feature.

## Contracts

| Endpoint                                | Behavior                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| POST `/v1/auth/dev-session`             | Body `{}`; matching Origin required; 201 `{expires_at}` plus cookie; 404 when disabled                                  |
| GET `/v1/me`                            | Valid session required; server-resolved account and current memberships                                                 |
| POST `/v1/auth/logout`                  | Body `{}`; session and Origin required; 204 and removal of the cookie/session                                           |
| GET `/v1/channels/:channel_id/sessions` | Session and OWNER/MODERATOR membership; limit/cursor pagination; OPERATOR does not automatically receive content access |
| GET `/health/live`                      | No session required; process liveness check                                                                             |
| GET `/health/ready`                     | No session required; checks foundation and session schema availability, not moderation pipeline readiness               |

Private endpoints use global guards. Channel routes must name their parameter `channel_id`. The Origin guard applies to methods other than GET/HEAD/OPTIONS. CORS only allows the configured dashboard origin; the Host and connection must also be loopback. The API does not trust X-Forwarded-Host/IP to bypass local restrictions.

Sessions use a random 256-bit token in the `atm_dev_session` cookie; the database stores only the token's SHA-256 hash. Cookies have HttpOnly, SameSite=Strict, Path=/, and Max-Age matching the TTL. Secure is not set because development endpoints use loopback HTTP; this configuration is not suitable for production deployment. Authentication responses use Cache-Control no-store.

Logging in again revokes the previous cookie if supplied and creates a new token. Each account is limited to 10 sessions; expired sessions are cleaned up during login. Sessions survive API restarts, but each request still checks expiration and current membership. The login body cannot supply an actor or role. Errors use the v1 envelope and X-Request-Id without raw tokens or database connection details.

## API database role

To separate migration and runtime accounts, store the local administrator connection as `MIGRATION_DATABASE_URL`. Add `RUNTIME_DB_ROLE=moderator_api` and a `RUNTIME_DB_PASSWORD` of your choice (at least 16 characters), then run:

```powershell
npm run db:runtime
```

After it succeeds, change the user/password in `DATABASE_URL` to the runtime role. URL-encode passwords containing special characters. `db:migrate` and `db:seed` use `MIGRATION_DATABASE_URL`; the API uses `DATABASE_URL`. The provisioning script requires a PostgreSQL administrator permitted to create roles and grant privileges.

The original development session role receives SELECT on account/channel/membership/stream session/run/configuration tables and SELECT/INSERT/DELETE on dashboard_sessions. The later OAuth feature adds account insertion and privileges for OAuth tables; rerun provisioning after applying its migration. The role does not own schemas/tables and cannot modify memberships or delete decisions/audit records. The script only manages roles it created, rejects unrelated existing roles, and can update managed role passwords. This feature does not provision the user's database automatically.

## Verification

```powershell
npm run build
npm test
$env:TEST_DATABASE_URL = 'postgresql://moderator:local_demo_only@127.0.0.1:15432/moderator'
npm run test:db
npm run test:auth
```

Authentication tests use an administrative local database connection: they create a random schema and role, run the HTTP API with the restricted runtime role, and clean up only test-owned resources. Do not point these tests at production. Recorded results are available in `docs/verification.md`.
