# Local Security Audit — 2026-10-05

This is a code and local-test audit of the portfolio application, starting from
commit `83251b0`. It is not a penetration test or production release approval.
No real YouTube moderation requests were sent during this audit.

## Changes

- Disable Express and Next.js identification headers.
- Add `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and a restrictive camera, microphone, and
  geolocation permissions policy to API and dashboard responses.
- Test safe API errors, malformed JSON, request body limits, and security headers.
- Test malicious chat and author strings as literal React text in both chat layouts.
- Update Next.js from `16.3.5` to `16.3.8` and NestJS packages to `12.1.2`.
  Override Multer to `2.4.0`. Keep the model runtime pins unchanged.
- Move the shadcn CLI to development dependencies; application code does not
  import it at runtime.

The Next.js update addresses the
[ImageResponse advisory](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j).
The reviewed application does not use `next/og` or `ImageResponse`.
HSTS is intentionally absent on local HTTP. Production HTTPS and a compatible
Content Security Policy require deployment-specific work.

## Reviewed controls and evidence

| Area                | Evidence in the reviewed local implementation                                                                           | Remaining boundary                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Credentials         | Only `.env.example` is tracked; environment files are ignored. Provider tokens remain server-side.                      | Inspect deployment secrets and built artifacts; complete credential rotation. |
| OAuth and tokens    | State, PKCE, expiring single-use attempts; AES-GCM with random IVs and account/purpose binding. Tampering tests pass.   | Production callback and secret-management configuration.                      |
| Sessions            | Random session tokens, stored hashes, expiry, logout/revocation, HttpOnly/SameSite cookies and provider-disable checks. | HTTPS/Secure cookies and production session lifecycle review.                 |
| Authorization       | Private HTTP and WebSocket access checks; channel/session binding; membership revalidation; owner-only settings writes. | Recheck against the deployed release and proxy environment.                   |
| Input and SQL       | Strict schemas, size/range limits, scoped cursors, parameterized values; restricted/quoted provisioning identifiers.    | This review cannot prove every future query is safe.                          |
| Error handling      | Safe public errors; tests inject SQL and password-like error text and verify it is not returned.                        | Production log access, retention, and incident handling.                      |
| XSS                 | Chat and author strings remain text; no reviewed HTML injection points. Both layouts reject executable markup.          | Production CSP and complete browser/deployment review.                        |
| Runtime permissions | Separate API/worker/migration identities and restricted runtime grants tested using isolated database schemas.          | Production network rules and administration paths.                            |
| WebSocket           | Origin/session/scope checks, payload and buffering limits, bounded replay, connection cap and access revalidation.      | Distributed limits, production proxy behavior and load testing.               |
| Worker              | Lease ownership, stale-worker rejection, checkpoints, deduplication and recovery tests.                                 | Operational monitoring and production failure/recovery exercises.             |

## Verification

- `npm run check`: TypeScript and formatting checks pass.
- Core packages, API and worker builds pass.
- Source/transport security selection: **84 tests pass** across security HTTP,
  Google/configuration, blacklist contracts/matcher, AI contracts, WebSocket and
  worker runtime tests.
- Database/HTTP selection: **158 tests pass** across authentication, live-feed
  access, blacklist/AI settings, monitoring/history, onboarding and worker leases.
- Dashboard suite: **239 tests pass**, including malicious chat fixtures.
- `npm ls` reports a consistent dependency graph for the reviewed NestJS/Multer
  packages. BullMQ retains its own compatible NestJS dependency subtree.
- A production Next.js build and a fresh manual browser security review were not
  performed in this audit. Dashboard configuration headers are tested directly.

Integration tests use isolated schemas and roles in the local database. They do
not reset application data. These selected suites are not the entire repository
test suite.

## Secret scan limitations

A local pattern scan examined 436 tracked files and added lines across 199 Git
commits. It found no matches for the six checked patterns: Google API keys,
Google OAuth client secrets, GitHub tokens, private-key headers, AWS access-key
identifiers, and literal 64-character token encryption keys.

This was not a dedicated secret scanner. It does not cover arbitrary passwords,
unknown formats, high-entropy detection, ignored files, or files larger than
2 MB. It does not establish that previously exposed credentials were rotated.
SEC-04 and credential rotation remain incomplete.

## Dependency findings

Before updates, the production audit reported 14 affected packages, including
one critical package. After updates, `npm audit --omit=dev` reports **two high
affected packages**: `@huggingface/transformers` and its `sharp` dependency.
These counts include dependent packages, not independent vulnerabilities.

The full audit, including development tools, reports **11 affected packages**:
nine high and two moderate, with no critical findings. Development CLI dependency
findings still need review; placing them in development dependencies does not
remove their risks when those tools run.

The remaining production chain uses `sharp@0.34.5`; review the
[sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
The application currently accepts text chat and has no file-upload or image
processing feature, which limits the reviewed exposure but is not a blanket
mitigation. A Transformers major upgrade needs a separate compatibility and
native inference test because this project previously encountered ONNX runtime
incompatibility. No force upgrade or risk acceptance was made here.

## Required follow-up before production

1. Rotate previously exposed OAuth credentials and encryption keys using a
   token migration or account reconnection plan.
2. Resolve or explicitly assess remaining dependency findings, including the
   model runtime and development tooling.
3. Implement and verify production configuration, HTTPS/WSS, Secure cookies,
   CSP, proxy trust, restricted database/Redis access and distributed rate limits.
4. Define data retention/deletion, logging access, backup restoration and incident
   response. Review provider data requirements before release.
5. Verify every applicable checklist item against the intended deployment.

The application still restricts runtime configuration to local development/test.
The production release gate remains **Pending**.
