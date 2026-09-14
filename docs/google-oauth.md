# Google OAuth and live broadcast listing

This implementation adds Google login and lists the user's broadcasts. It does not enable monitoring, chat ingestion, WebSocket, classification, or enforcement.

## Local setup

1. In Google Cloud, enable YouTube Data API v3 and configure the OAuth consent screen. For an app in Testing mode, register the Google test accounts.
2. Use a Web application OAuth client. Register this exact authorized redirect URI: `http://127.0.0.1:3001/v1/auth/google/callback`.
3. Set the client ID and rotated client secret in the local `.env`. Never put tokens or secrets in `NEXT_PUBLIC_*`, Git, or logs.
4. Generate `TOKEN_ENCRYPTION_KEY` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Store the result in `.env` and keep this key so stored tokens remain readable after restarts.
5. Set `GOOGLE_AUTH_ENABLED=true`, `DEV_AUTH_ENABLED=false`, and `GOOGLE_REDIRECT_URI` as above. The dashboard and API must use the same hostname; do not mix `localhost` and `127.0.0.1`.
6. Start PostgreSQL and run `npm run build:core`, `npm run db:migrate`, and `npm run db:runtime` if using a runtime role. Migration 003 is required even when Google authentication is disabled because the session guard uses the provider column.
7. Start the API and dashboard. Open `http://127.0.0.1:3001/v1/auth/google` to begin consent, or use the Google login button on the dashboard. After success, the callback redirects to `/?auth=connected`. This parameter only indicates navigation status; authentication is still verified through the session cookie. The `/live` page is a subsequent frontend task; update the callback destination when that page is available.

The user's `.env` is not modified automatically. Previously shared secrets are not copied into the repository.

## Endpoints

| Endpoint                       | Behavior                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| GET `/v1/auth/providers`       | Reports Google login availability without exposing credentials                                                      |
| GET `/v1/auth/google`          | Creates state and browser binding, then redirects to Google                                                         |
| GET `/v1/auth/google/callback` | Validates the single-use callback, stores the grant, and creates a session cookie                                   |
| GET `/v1/me`                   | Resolves the application account from the session cookie                                                            |
| POST `/v1/auth/logout`         | Deletes the application session; requires body `{}` and the dashboard Origin                                        |
| GET `/v1/youtube/broadcasts`   | Lists live broadcasts accessible through the signed-in account's Google grant; refreshes a token nearing expiration |

Broadcast listing currently checks the first page (up to 50 resources) and returns `truncated=true` when another page exists. Clients must display this limitation rather than conclude that no live stream exists when results are truncated. Internal channel mapping and full pagination are part of the next monitoring integration.

## Security and operational limits

- Authorization codes are exchanged only in NestJS using PKCE S256. State and the random browser cookie must match, expire after at most 10 minutes, and are consumed atomically in PostgreSQL.
- Identity is based on `sub` from Google's UserInfo endpoint using the access token obtained from the code exchange, not an email or account ID submitted by the frontend.
- Tokens are encrypted with AES-256-GCM; authenticated context binds each token to its account and token type. The database stores only ciphertext and session token hashes.
- Refresh tokens are retained when Google does not send a replacement. Concurrent refreshes are serialized per account. Grant failures require reconnection and do not enable development access.
- Scopes: `openid`, `profile`, and `youtube.force-ssl` for the selected YouTube moderation requirements. This feature's endpoints perform no delete/timeout/ban actions.
- The API remains limited to loopback HTTP development. The callback cookie uses SameSite=Lax; the session cookie remains HttpOnly/SameSite=Strict. Production requires HTTPS, Secure cookies, a revised host policy, rate limits, and retention and access revocation policies.
- Logout ends the application session without revoking Google consent. A disconnect/revoke endpoint and grant deletion are still required before release.
- Google accounts are never automatically linked to the seeded development channel.

## Verification

`npm run typecheck` and `npm run test:google` check the current source checkout directly. Google tests use a mock HTTP transport and do not send credentials to Google. The user has reported successful local login and endpoint checks. Full database integration coverage, refresh after restart, and end-to-end monitoring verification are still required before release.

References: [Google web server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [scopes and refresh tokens](https://developers.google.com/identity/protocols/oauth2), [liveBroadcasts.list](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list).
