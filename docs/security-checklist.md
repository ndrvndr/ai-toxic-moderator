# Security Checklist

This checklist tracks security verification before the first production release.

A completed implementation is not sufficient to mark a control as verified.
Each verified control must include evidence from code review, configuration
inspection, or testing.

Never include secret values, access tokens, passwords, or sensitive user data
in this document or its supporting evidence.

## Status Definitions

- **Pending**: Verification or implementation is still required.
- **Partially verified**: Local evidence exists, but some criteria or production checks remain incomplete.
- **Verified**: The control has been checked and supporting evidence is recorded.
- **Not applicable**: The feature is outside the current scope. Reassess when
  the scope changes.

## Core Security Controls

| ID     | Control                    | Verification criteria                                                                                                                                                              | Status             |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| SEC-01 | API keys and credentials   | Credentials remain server-side. Apply provider restrictions where supported and use minimum required scopes.                                                                       | Partially verified |
| SEC-02 | Environment configuration  | Production secrets are supplied securely. Environment files are excluded from Git, public assets, build artifacts, and HTTP responses. Example files contain placeholders only.    | Partially verified |
| SEC-03 | Hardcoded secrets          | Source code, tests, fixtures, scripts, and generated frontend bundles contain no real credentials.                                                                                 | Partially verified |
| SEC-04 | Git secret scanning        | Scan the working tree and Git history. Revoke or rotate exposed credentials; deleting them from the latest revision is insufficient.                                               | Partially verified |
| SEC-05 | Production configuration   | Disable development authentication and debug tooling. Validate production configuration and fail startup when required security settings are missing.                              | Partially verified |
| SEC-06 | Error disclosure           | Client errors contain safe messages. Responses and logs do not expose credentials, raw provider responses, SQL, or stack traces containing sensitive details.                      | Partially verified |
| SEC-07 | Input validation           | Validate HTTP parameters, request bodies, headers, cursors, and WebSocket subscription parameters server-side. Enforce size and range limits.                                      | Partially verified |
| SEC-08 | Input handling             | Apply context-specific normalization and output encoding. Preserve original chat content when needed for moderation evidence. Avoid blanket transformations that corrupt evidence. | Partially verified |
| SEC-09 | SQL injection prevention   | Parameterize query values. Restrict and quote dynamic SQL identifiers. Review raw SQL and provisioning scripts.                                                                    | Partially verified |
| SEC-10 | XSS prevention             | Render chat content as text. Review HTML injection points and URL handling. Test malicious chat fixtures and configure appropriate browser security headers.                       | Partially verified |
| SEC-11 | Server-side authentication | Protect private HTTP endpoints and WebSocket upgrades. Reject missing, invalid, expired, and revoked sessions.                                                                     | Partially verified |
| SEC-12 | Resource authorization     | Verify account access to every requested channel, session, monitoring run, and history resource. Test cross-account access and revoked membership.                                 | Partially verified |
| SEC-13 | Privileged roles           | Restrict privileged operations server-side. Prevent role escalation through client input or ordinary account endpoints. Document allowed actions for every role.                   | Partially verified |
| SEC-14 | Database network access    | Production database access is restricted to approved services and administration paths. It is not reachable by arbitrary internet clients.                                         | Pending            |
| SEC-15 | Database permissions       | API, worker, and migration identities have separate permissions. Runtime identities cannot perform unrestricted administration or schema changes.                                  | Partially verified |
| SEC-16 | Password storage           | No local passwords are stored because authentication uses Google OAuth. Reassess before introducing password authentication.                                                       | Not applicable     |
| SEC-17 | Session security           | Verify production HTTPS cookies, HttpOnly, Secure, SameSite, expiration, rotation, logout, CSRF protection, and WebSocket access revalidation.                                     | Partially verified |
| SEC-18 | Password recovery          | The application has no local password reset flow. Google manages account recovery. Reassess before adding local credentials.                                                       | Not applicable     |
| SEC-19 | Upload restrictions        | The current application has no file upload feature. Before adding one, define authentication, size limits, permitted formats, content validation, and isolated storage.            | Not applicable     |
| SEC-20 | Upload scanning            | The current application has no file upload feature. Before adding one, assess malware scanning and quarantine requirements before files are processed or served.                   | Not applicable     |

## Application-Specific Controls

| ID     | Control                        | Verification criteria                                                                                                                                                             | Status             |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| APP-01 | Google OAuth                   | Verify state, PKCE, callback validation, minimum scopes, account linking, and rejection of replayed or expired authorization attempts.                                            | Partially verified |
| APP-02 | Provider token protection      | Encrypt stored access and refresh tokens. Restrict access to encryption keys and prevent token exposure in URLs, responses, logs, and frontend state.                             | Partially verified |
| APP-03 | Credential rotation            | Rotate previously exposed credentials. Plan token re-encryption or account reconnection before replacing the token encryption key.                                                | Pending            |
| APP-04 | Rate limiting                  | Limit authentication attempts, monitoring requests, and WebSocket connections. Ensure limits work across production instances.                                                    | Pending            |
| APP-05 | WebSocket security             | Validate Origin, session, subscription scope, and cursors. Recheck access during connections. Bound payloads, buffering, replay batches, idle connections, and connection counts. | Partially verified |
| APP-06 | Browser and transport security | Enforce HTTPS/WSS in production. Review CORS allowlists, proxy trust, security headers, and cache policies for authenticated responses.                                           | Partially verified |
| APP-07 | Dependency security            | Scan production dependencies and lockfiles. Review unresolved vulnerabilities and document relevant mitigations.                                                                  | Partially verified |
| APP-08 | Moderation action safety       | Authorize actions against the correct YouTube channel. Prevent duplicate execution, bound retries, record provider-confirmed outcomes, and provide an emergency stop.             | Pending            |
| APP-09 | Worker reliability             | Verify lease ownership, stale-worker rejection, cancellation, transactional checkpoints, deduplication, and recovery after failure.                                               | Partially verified |
| APP-10 | Quota protection               | Honor provider polling intervals and retry guidance. Stop inappropriate retries after quota exhaustion and monitor project usage.                                                 | Pending            |
| APP-11 | Logging and audit              | Record authentication failures, access denials, monitoring transitions, and moderation outcomes without exposing secrets or unnecessary chat content. Restrict log access.        | Pending            |
| APP-12 | Data retention                 | Define retention and deletion for chat content, identities, credentials, history, logs, and backups. Review applicable YouTube API data requirements before release.              | Pending            |
| APP-13 | Backup and recovery            | Protect backups, restrict access, and verify restoration. Document recovery steps and encryption key dependencies.                                                                | Pending            |
| APP-14 | Deployment exposure            | Inventory public routes and services. Restrict health details, administrative tools, metrics, databases, and Redis as appropriate.                                                | Partially verified |

## Known Follow-up Work

- Google OAuth client credentials and a token encryption key were previously
  shared outside the application's secret storage. Treat them as exposed and
  rotate them before production.
- Do not record the exposed values in this checklist.
- Replacing the token encryption key without migration will prevent decryption
  of existing stored tokens. Define re-encryption or account reconnection first.
- The application currently includes development-specific runtime restrictions.
  Production configuration and deployment require a separate review.
- Reassess every "Not applicable" item when adding authentication methods,
  uploads, or other features that change its applicability.

## Verification Record

Add one entry for each verified control. Reference a commit, test, report, or
configuration review without including sensitive values.

### Template

- **Control ID:**
- **Reviewed by:**
- **Date:**
- **Commit or release:**
- **Environment:**
- **Verification method:**
- **Evidence:**
- **Result:**
- **Remaining work:**

## Live Feed Access Verification

- **Control IDs:** SEC-06, SEC-11, SEC-12, SEC-13, SEC-17, APP-05
- **Environment:** Local test environment
- **Verification date:** 2026-09-15
- **Commit:** 583e314
- **Evidence:**
  - `npm run test:live-event-feed`
  - `npm run test:live-websocket`
- **Coverage:**
  - Owner and moderator access.
  - Operator and missing-membership denial.
  - Cross-channel and cross-session access denial.
  - Missing, unknown, expired, and revoked sessions.
  - Membership changes and disabled authentication providers.
  - Invalid future cursors.
  - WebSocket closure after authentication failure.
  - Rejection of client application messages.
  - Safe WebSocket error messages.
- **Limitations:**
  - Database access tests use a local test database.
  - Transport tests use a replacement access service.
  - Production configuration, proxy behavior, connection limits,
    slow clients, and full application shutdown require further verification.
- **Checklist status:** Related controls remain Pending until all their
  verification criteria are covered.

## Release Gate

Before production launch:

- Verify every applicable control against the intended release and environment.
- Resolve known credential exposure.
- Resolve blocking security findings.
- Record an owner, mitigation, and review date for any accepted non-blocking risk.
- Confirm that "Not applicable" decisions still match the release scope.
- Complete backup restoration and incident response preparation.
- Record the final release review below.

## Release Review

- **Release or commit:** Pending
- **Review date:** Pending
- **Reviewer:** Pending
- **Blocking findings:** Not yet assessed
- **Accepted risks:** Not yet assessed
- **Release decision:** Pending

## Local Audit — 2026-10-05

- **Scope:** Code review and selected local tests, starting from `83251b0`.
- **Evidence:** [Local security audit](security-audit-2026-10-05.md).
- **Result:** Reviewed controls have local evidence and are marked Partially
  verified. No control is newly marked fully Verified by this audit.
- **Remaining work:** Credential rotation, dependency findings, production
  deployment controls, rate limits, retention, backups and incident preparation.
- **Release decision:** Pending. Passing local tests does not establish
  production readiness.
