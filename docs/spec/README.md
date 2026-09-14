# MVP specification — AI Toxic Moderator

Version: 0.1 · September 13, 2026 · Status: the first milestone scope was established following the user's instruction to continue planning. This is an implementation specification, not a claim that the application is complete. For the subsequent Google OAuth, shadcn, and automatic monitoring direction, see [the updated product direction](04-live-product-direction.md).

## Defined scope

- One pilot channel with synthetic Indonesian messages.
- Manual message input through the dashboard or fixtures; asynchronous processing.
- Normalization that preserves original text, deterministic rules, and simulation policies.
- Persist decisions, evidence, configuration versions, simulated actions, feedback, and audit records.
- Dashboard: summaries, live feed, decision details, feedback, and connection status.
- PostgreSQL and Redis/BullMQ are included in the first milestone so asynchronous processing and persistence are actually tested. The second milestone hardens reliability and operations rather than introducing storage for the first time.
- TypeScript monorepo: Next.js/React, NestJS API, NestJS worker, shared contracts, and moderation core. NestJS follows the user's framework choice.

Excluded from the original milestone: YouTube ingestion/OAuth, a real ML model, provider actions, rule/policy editors, replay UI, reputation/escalation, advanced analytics, and public deployment. Fields and module boundaries accommodate those phases without presenting unavailable features as implemented.

## Implementation documents

1. [Database schema](01-database.md): entities, fields, relationships, constraints, indexes, and transactions.
2. [API and event contracts](02-api-events.md): payloads, validation, errors, idempotency, and SSE.
3. [Backlog and acceptance](03-backlog.md): task order, dependencies, and test scenarios.
4. [Updated product direction](04-live-product-direction.md): automatic YouTube monitoring, shadcn, and WebSocket.

This specification expands and, within the first milestone scope, replaces ambiguous parts of the kickoff plan. Source blueprints remain references, not execution instructions.

## Development policy decisions

Immutable configurations `ruleset-dev-1` and `policy-dev-1`; changes create new versions. The goal is to test the mechanism, not yet prove production moderation quality.

| Fixture case                                        | Signal                             | Outcome         | Action plan      |
| --------------------------------------------------- | ---------------------------------- | --------------- | ---------------- |
| No matching rule                                    | None within the demo rule coverage | ALLOW           | Empty            |
| Ambiguous term without complete conditions          | Candidate requires context         | REVIEW          | Empty            |
| Gambling entity and explicit promotional invitation | GAMBLING, S3                       | ACTION_REQUIRED | Simulated DELETE |
| Direct insult toward a target within a demo pattern | HARASSMENT, S2                     | ACTION_REQUIRED | Simulated DELETE |
| Pipeline failure after retries are exhausted        | Processing error                   | ERROR           | Empty            |

ALLOW means the demo rules detected nothing; it does not guarantee safety across all categories. The first milestone policy does not produce TIMEOUT/BAN. Threats, hate, scams, PII, and other blueprint categories are not implemented; coverage is displayed in the dashboard.

Rules produce `strength: STRONG | AMBIGUOUS`; numeric `confidence` is nullable and always null for uncalibrated demo rules. Do not turn deterministic matches into accuracy percentages. Severity comes from the matched rule, not confidence.

The following Indonesian strings are intentional moderation fixtures and retain their original wording. Initial positive examples: “ayo daftar judi online di contoh.invalid sekarang” and “kamu bodoh”. REVIEW example: “slot”. Required ALLOW hard negatives: “slot RAM”, “babi hutan”, “judi itu berbahaya”, “anjing laut”, “gila keren”, and “jangan bilang kamu bodoh”. Exceptions apply to the relevant span/context, so “slot RAM bagus, ayo daftar judi online di contoh.invalid sekarang” still produces ACTION_REQUIRED. Demo rules are limited to documented patterns and do not claim general understanding of Indonesian intent.

## NestJS backend structure

`apps/api` uses NestJS with the default Express adapter. Planned API modules: AuthModule, ChannelsModule, IngestionModule, DecisionsModule, FeedbackModule, EventsModule, and HealthModule. Controllers handle HTTP; services coordinate use cases/transactions; guards check sessions/memberships; validation pipes run shared schemas; and exception filters map errors to the v1 contract.

`apps/worker` uses a separate NestJS application context without an HTTP listener, with ModerationWorkerModule and OutboxModule. Queue integration uses `@nestjs/bullmq`; processors are registered only in the worker so the API does not consume jobs. Worker lifecycle handling covers startup, shutdown, and connection cleanup.

`packages/moderation-core` contains TypeScript logic without HTTP or NestJS decorator dependencies. Persistence and configuration are injected through providers. Data contracts remain framework-independent so the dashboard and worker share schemas. The API framework does not determine the ORM; the initial specification leaves that choice open.

References: [NestJS](https://docs.nestjs.com/) and [BullMQ integration](https://docs.nestjs.com/techniques/queues).

## Local development access

One seeded development moderator account has membership in the pilot channel; the actor is not accepted from request bodies. Endpoints and SSE still enforce membership checks. Development sessions are enabled only through explicit local configuration, using HttpOnly/SameSite cookies and Origin validation for mutations. The API/frontend bind to loopback; development sessions must not be used as a public deployment login method. Production OIDC remains an integration phase.

## Completed demo criteria

The user enters a message → sees processing status → receives a new decision without refreshing → opens raw text/evidence/reasons → submits feedback → feedback remains available after restart. Resending the same external ID with identical content does not create additional messages, decisions, or actions.

Provisional kickoff operational targets are not production release requirements. The backlog defines completion for this milestone, including test results to report when the code is available.
