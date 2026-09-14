# First milestone backlog

Update dated September 14, 2026: the M1-01–03 foundation is available; the M1-04 development session backend, membership guards, Origin validation, and runtime role provisioning were implemented on `feat/dev-session-access`. See `docs/dev-session-access.md` and `docs/verification.md` for usage, test results, and limitations. M1-05 and later items in this original sequence have not started. Subsequent Google OAuth and dashboard work follows the [updated product direction](04-live-product-direction.md).

## Work sequence

| ID    | Work / deliverable                                                                                                                                                       | Dependencies | Acceptance criteria                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1-01 | Scaffold monorepo: Next.js dashboard, NestJS/Express API, NestJS worker application context; packages/contracts, moderation-core, persistence, config, provider-adapters | —            | Strict TypeScript, lockfile, dev/build/check scripts; API and worker boot separately; @nestjs/bullmq processors run only in the worker; fresh installation and build succeed on the documented runtime |
| M1-02 | Runtime schemas and request/response/event fixtures                                                                                                                      | M1-01        | Invalid fields, unknown fields, invalid spans, unknown statuses, and invalid conditional feedback fields are rejected; valid fixtures are accepted                                                     |
| M1-03 | PostgreSQL migrations; seed one channel/session/run/bundle/account                                                                                                       | M1-02        | Migrate an empty database; idempotent seed; cross-channel foreign keys and duplicate constraints are tested; session/run rules remain consistent                                                       |
| M1-04 | Development sessions, membership, Origin checks, local binding restrictions                                                                                              | M1-03        | Clients cannot inject an actor; other channels are rejected; development sessions cannot be enabled under public/production configuration                                                              |
| M1-05 | Ingestion API, task, and transactional outbox                                                                                                                            | M1-04        | POST returns 202; identical duplicates create one row/task; conflicting duplicates return 409; raw text remains byte-for-byte identical after JSON decoding/UTF-8 encoding                             |
| M1-06 | Text processor, evidence mapping, demo rules, and immutable policy                                                                                                       | M1-02        | All fixtures below pass; policy creates actions only for strong matches; null confidence; pinned versions                                                                                              |
| M1-07 | Outbox dispatcher, BullMQ worker, persistence of decisions/simulated actions/audit                                                                                       | M1-03,05,06  | Event → decision; parallel retries produce one result; no provider/network enforcement; transaction rollback leaves no action without a decision                                                       |
| M1-08 | Feed/detail/task APIs and persisted SSE                                                                                                                                  | M1-07        | Deterministic pagination, active filters, snapshot watermark, and resume without event loss; access to each resource is verified                                                                       |
| M1-09 | App shell, message form, feed, details, and displayed-result summaries                                                                                                   | M1-08        | Input → task status → decision without refresh; details preserve raw text; clear empty/loading/error/offline states and SIMULATION labels                                                              |
| M1-10 | Feedback API, audit, and UI                                                                                                                                              | M1-04,08,09  | Idempotent submission/retry; corrections stored separately from decisions; cache refreshed on feedback events                                                                                          |
| M1-11 | Terminal failure retries, reconciler, graceful shutdown, readiness, and logs                                                                                             | M1-07,08     | Worker/Redis restarts create no duplicates; terminal failures appear as ERROR; stuck tasks can be recovered                                                                                            |
| M1-12 | E2E, integration failure checks, core accessibility, and demo README                                                                                                     | M1-09,10,11  | All acceptance gates below pass; setup/test/demo commands are validated from a clean environment                                                                                                       |

Do not assign calendar estimates without knowing developer capacity and the environment. Organize work into testable outcomes: foundation (01–04), pipeline (05–07), dashboard (08–10), and verification (11–12).

## Minimum regression fixtures

These expected results specify demo rules, not model training labels or general classifier capabilities. Indonesian messages are intentionally preserved as test data; translating them would change the behavior being tested.

| ID  | Message / condition                                                               | Expected result                                                    |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| F01 | slot RAM                                                                          | ALLOW, no actions                                                  |
| F02 | babi hutan                                                                        | ALLOW                                                              |
| F03 | judi itu berbahaya                                                                | ALLOW                                                              |
| F04 | anjing laut                                                                       | ALLOW                                                              |
| F05 | gila keren                                                                        | ALLOW                                                              |
| F06 | ayo daftar judi online di contoh.invalid sekarang                                 | ACTION_REQUIRED, GAMBLING, S3, DELETE/SIMULATED                    |
| F07 | kamu bodoh                                                                        | ACTION_REQUIRED, HARASSMENT, S2, DELETE/SIMULATED                  |
| F08 | slot                                                                              | REVIEW, no actions                                                 |
| F09 | jangan bilang kamu bodoh                                                          | ALLOW; span/context exception                                      |
| F10 | slot RAM bagus, ayo daftar judi online di contoh.invalid sekarang                 | ACTION_REQUIRED; a benign exception does not cancel other evidence |
| F11 | AYO DAFTAR JUDI ONLINE di contoh.invalid SEKARANG                                 | F06 result after normalization; raw text remains intact            |
| F12 | 😀 kamu bodoh                                                                     | F07 result; correct UTF-16 span after the emoji                    |
| F13 | ｋａｍｕ bodoh                                                                    | F07 result after NFKC; correct raw span or explicitly UNAVAILABLE  |
| F14 | Repeat F06 with the same external ID and payload                                  | Message/task/decision/action counts do not increase                |
| F15 | Repeat the F06 external ID with different raw text                                | HTTP 409; original message remains unchanged                       |
| F16 | Whitespace-only or more than 2,000 code points                                    | HTTP 422; no message/outbox record                                 |
| F17 | Deterministic processing error after retries are exhausted (fault injection test) | Task FAILED, decision ERROR, no actions                            |

Before implementing rules, define tokens/phrases and context boundaries for F06–F13 in the seed configuration. Do not implement exceptions by hardcoding entire fixture sentences. Add positive and negative variations independent of the example patterns to test limited generalization.

## Demo acceptance gates

1. Running the documented setup against an empty database produces a pilot channel/session and known rule/policy versions.
2. F06 input produces one inspectable decision with its message, evidence, reason, versions, and SIMULATED action badge.
3. False-positive feedback appears in the details without modifying the original decision. Decisions and feedback remain available from the development volume after API/worker/database restarts.
4. Duplicate POSTs and duplicate queue delivery do not create additional decisions or actions.
5. Stop Redis after ingestion commits: the task/outbox remain persisted; once Redis returns, the message completes effectively once.
6. Crash the worker before commit, then restart: no partial decision/action exists; reprocessing completes.
7. Disconnect SSE, create several decisions, then reconnect: all decisions eventually appear without duplicates. Also test cursor resets, concurrent commits, and filtering/pagination.
8. Invalid sessions and access to other channels are rejected by the API and SSE. Mutations from unauthorized origins are rejected. HTML payloads render as text.
9. Keyboard users can enter messages, select feed items, open/close details, and submit feedback; focus returns to the panel trigger; status does not rely on color alone.
10. All F01–F17 fixtures and their variations pass. The README distinguishes available categories, unsupported categories, and demo rule limitations.

## Required implementation artifacts

- Repository and lockfile; migrations/seeds; `.env.example` without secrets.
- Runtime schemas/OpenAPI; fixture corpus; versioned rule/policy configuration.
- Unit tests for high-risk domain logic, integration tests for persistence/queues/access, and E2E tests for the main flow.
- README covering setup, process startup, tests, demo instructions, Redis/worker troubleshooting, and explicit development reset.
- A results report: tests executed, pass/fail outcomes, remaining failures, and limitations. No performance/accuracy figures may be claimed before measurement.

## After the first milestone

Original sequence: M2 hardens recovery/backpressure/metrics and replay schemas. M3 covers datasets/evaluation and Indonesian model selection. M4 covers OIDC, YouTube OAuth, and shadow ingestion. M5 covers approved action policies, provider guards/executors, and UNKNOWN reconciliation. Do not enable provider features by simply changing the simulator flag. The newer product direction advances Google OAuth and automatic monitoring work; use that document to resolve scheduling differences.
